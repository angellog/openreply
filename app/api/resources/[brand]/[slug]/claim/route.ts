import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getRequestIp, hashClickIp } from "@/lib/tracking/server";
import { getBaseUrl } from "@/lib/env";
import { sendEmail } from "@/lib/email/send";
import {
  MARKETING_CONSENT_TEXT,
  buildDeliveryEmail,
  normalizeEmail,
  normalizeName,
  rejectionMessage,
} from "@/lib/resources/claim";

/**
 * The email gate.
 *
 * The link is returned to the page AND emailed. Returning it means nobody who
 * gave a real address is left waiting on an inbox; emailing it means a junk
 * address bounces, and a bounced address never becomes an outbound prospect.
 *
 * A failed send is never an error on the visitor's screen. They have their
 * link; the delivery failure is ours to see.
 */

const claimSchema = z.object({
  email: z.string().max(320),
  name: z.string().max(120).optional(),
  /** Explicit, and false unless they ticked it. */
  consentMarketing: z.boolean().default(false),
  /** Tracked link slug, when they arrived through one. */
  ref: z.string().max(64).optional(),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ brand: string; slug: string }> }
) {
  const { brand, slug } = await params;

  const parsed = claimSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: "Check the form and try again." },
      { status: 422 }
    );
  }

  const normalized = normalizeEmail(parsed.data.email);
  if (!normalized.ok) {
    return NextResponse.json(
      { success: false, error: rejectionMessage(normalized.reason), code: normalized.reason },
      { status: 422 }
    );
  }

  const resource = await prisma.resource.findFirst({
    where: {
      slug,
      isPublished: true,
      workspace: { publicSlug: brand },
    },
    select: {
      id: true,
      workspaceId: true,
      title: true,
      destinationUrl: true,
      workspace: { select: { name: true, publicSlug: true } },
    },
  });
  if (!resource) {
    return NextResponse.json({ success: false, error: "Not found" }, { status: 404 });
  }

  const trackedLink = parsed.data.ref
    ? await prisma.trackedLink.findUnique({
        where: { slug: parsed.data.ref },
        select: { id: true, workspaceId: true },
      })
    : null;

  const now = new Date();
  const consented = parsed.data.consentMarketing;
  const lead = {
    name: normalizeName(parsed.data.name),
    consentMarketing: consented,
    // Only recorded when they actually agreed, so a row can never imply a
    // consent that was never given.
    consentText: consented ? MARKETING_CONSENT_TEXT : null,
    consentedAt: consented ? now : null,
    refSlug: parsed.data.ref ?? null,
    // A ref from another workspace is someone else's link; keep the slug for
    // the record but do not attach the row to it.
    trackedLinkId:
      trackedLink && trackedLink.workspaceId === resource.workspaceId ? trackedLink.id : null,
    ipHash: hashClickIp(getRequestIp(request)),
    userAgent: request.headers.get("user-agent"),
    referrer: request.headers.get("referer"),
  };

  // Asking again for the same thing is a re-send, not a second lead. Consent
  // is only ever moved forward: someone who opted in once is not opted out by
  // a later download where they left the box alone.
  await prisma.resourceLead.upsert({
    where: { resourceId_email: { resourceId: resource.id, email: normalized.email } },
    create: {
      workspaceId: resource.workspaceId,
      resourceId: resource.id,
      email: normalized.email,
      ...lead,
    },
    update: {
      ...lead,
      ...(consented
        ? {}
        : { consentMarketing: undefined, consentText: undefined, consentedAt: undefined }),
      deliveryStatus: "PENDING",
      deliveryError: null,
    },
  });

  const brandName = resource.workspace.name;
  const hubUrl = `${getBaseUrl().replace(/\/$/, "")}/resources/${resource.workspace.publicSlug}`;
  const message = buildDeliveryEmail({
    resourceTitle: resource.title,
    destinationUrl: resource.destinationUrl,
    brandName,
    hubUrl,
  });

  const sent = await sendEmail({ to: normalized.email, ...message });

  await prisma.resourceLead
    .update({
      where: { resourceId_email: { resourceId: resource.id, email: normalized.email } },
      data: {
        deliveryStatus: sent.ok ? "SENT" : "FAILED",
        deliveryError: sent.ok ? null : sent.error.slice(0, 500),
      },
    })
    .catch(() => undefined);

  if (!sent.ok) {
    await prisma.operationalEvent
      .create({
        data: {
          workspaceId: resource.workspaceId,
          source: "SYSTEM",
          level: "WARNING",
          message: `Could not email "${resource.title}" to a new lead`,
          payload: { resourceId: resource.id, error: sent.error.slice(0, 500) },
        },
      })
      .catch(() => undefined);
  }

  return NextResponse.json({
    success: true,
    data: {
      url: resource.destinationUrl,
      emailed: sent.ok,
    },
  });
}
