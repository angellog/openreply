import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { authenticateHarveyRequest } from "@/lib/harvey/auth";
import { buildWhatsAppHandoffUrl } from "@/lib/whatsapp/ref";
import { generateTrackedLinkSlug } from "@/lib/tracking/server";
import { buildTrackedUrl } from "@/lib/tracking/message";

/**
 * Mints the one tracked link a cold email is allowed to carry.
 *
 * This is where the two halves meet. The link is an ordinary TrackedLink, so
 * /r/<slug> logs the click and — for a WhatsApp handoff — redirects to wa.me
 * with "(ref: <slug>)" in the pre-filled text. When the prospect sends that,
 * lib/whatsapp/inbound.ts recognises the slug and the chat is attributed to
 * this exact email. No new attribution code: the Instagram path already built
 * all of it.
 *
 * Harvey's own writer allows at most one link across a three-email sequence
 * (prompts/writer.md, enforced by harvey/gate.py MAX_LINKS = 1), so this is
 * called rarely, usually for step 2 or for a reply.
 *
 * Where the link points is NOT in the request. The agent's configured
 * destination is used, so a compromised agent cannot turn this domain into an
 * open redirect to a number or a site the operator never chose.
 */

const requestSchema = z.object({
  /** The mirrored email this link belongs to. Makes minting idempotent and is
   *  the join that turns a WhatsApp reply back into "this email worked". */
  emailHarveyId: z.string().min(1).max(64),
  /** Which of the agent's configured destinations to use. */
  destination: z.enum(["whatsapp", "default"]).default("whatsapp"),
  label: z.string().max(200).optional(),
});

export async function POST(request: NextRequest) {
  const auth = await authenticateHarveyRequest(request);
  if (!auth.ok) {
    return NextResponse.json(
      { success: false, error: "Unauthorized", code: auth.code },
      { status: auth.status }
    );
  }

  const { agent, rawBody } = auth;

  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ success: false, error: "Body is not JSON" }, { status: 400 });
  }

  const parsed = requestSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: "Invalid request", issues: parsed.error.issues.slice(0, 10) },
      { status: 422 }
    );
  }

  const { emailHarveyId, destination, label } = parsed.data;

  // Mint only against an email already mirrored here, so a link can never
  // dangle without the message that carries it.
  const email = await prisma.harveyEmail.findUnique({
    where: { agentId_harveyId: { agentId: agent.id, harveyId: emailHarveyId } },
    select: { id: true, trackedLink: { select: { slug: true } } },
  });
  if (!email) {
    return NextResponse.json(
      { success: false, error: `No synced email with harveyId '${emailHarveyId}'`, code: "UNKNOWN_EMAIL" },
      { status: 404 }
    );
  }

  // Harvey retries on any network failure, so a second call for the same email
  // must return the same link rather than minting a second one.
  if (email.trackedLink) {
    return NextResponse.json({
      success: true,
      data: {
        slug: email.trackedLink.slug,
        url: buildTrackedUrl(email.trackedLink.slug),
        reused: true,
      },
    });
  }

  if (destination === "whatsapp" && !agent.whatsappPhone) {
    return NextResponse.json(
      {
        success: false,
        error: `Agent "${agent.name}" has no WhatsApp number configured. Set one in Outreach settings, or mint with destination "default".`,
        code: "NO_DESTINATION",
      },
      { status: 409 }
    );
  }
  if (destination === "default" && !agent.defaultDestinationUrl) {
    return NextResponse.json(
      {
        success: false,
        error: `Agent "${agent.name}" has no default destination configured (a booking page, usually).`,
        code: "NO_DESTINATION",
      },
      { status: 409 }
    );
  }

  const slug = generateTrackedLinkSlug();
  const destinationUrl =
    destination === "whatsapp"
      ? buildWhatsAppHandoffUrl({
          phone: agent.whatsappPhone as string,
          slug,
          message: agent.whatsappMessage ?? "Hi! I got your email",
        })
      : (agent.defaultDestinationUrl as string);

  const trackedLink = await prisma.trackedLink.create({
    data: {
      workspaceId: agent.workspaceId,
      automationId: null,
      source: "HARVEY_EMAIL",
      slug,
      label: label ?? null,
      destinationUrl,
    },
    select: { id: true, slug: true },
  });

  await prisma.harveyEmail.update({
    where: { id: email.id },
    data: { trackedLinkId: trackedLink.id },
  });

  return NextResponse.json({
    success: true,
    data: {
      slug: trackedLink.slug,
      url: buildTrackedUrl(trackedLink.slug),
      reused: false,
    },
  });
}
