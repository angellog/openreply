import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { getRequestIp, hashClickIp } from "@/lib/tracking/server";
import { resolveRefPlaceholder } from "@/lib/whatsapp/ref";
import {
  findHarveyEmailForTrackedLink,
  recordOutreachEvent,
} from "@/lib/outreach/events";

type RedirectRouteProps = {
  params: Promise<{ slug: string }>;
};

export async function GET(request: NextRequest, { params }: RedirectRouteProps) {
  const { slug } = await params;
  const trackedLink = await prisma.trackedLink.findUnique({
    where: { slug },
    select: {
      id: true,
      workspaceId: true,
      automationId: true,
      source: true,
      destinationUrl: true,
      automation: {
        select: {
          instagramAccountId: true,
        },
      },
    },
  });

  if (!trackedLink) {
    return NextResponse.redirect(new URL("/", request.url), { status: 302 });
  }

  await prisma.linkClick.create({
    data: {
      workspaceId: trackedLink.workspaceId,
      // Both null for an outbound link (Harvey cold email): there is no
      // Instagram campaign behind it. The click is still recorded, and the
      // WhatsApp ref below still attributes the chat to this exact link.
      automationId: trackedLink.automationId,
      instagramAccountId: trackedLink.automation?.instagramAccountId ?? null,
      trackedLinkId: trackedLink.id,
      ipHash: hashClickIp(getRequestIp(request)),
      userAgent: request.headers.get("user-agent"),
      referrer: request.headers.get("referer"),
    },
  });

  // A click on an outbound link is news the agent that sent it cannot see for
  // itself, so it goes on the event stream. Awaited rather than fired and
  // forgotten: this runs in a serverless function that may be frozen the
  // moment the response is returned.
  if (trackedLink.source === "HARVEY_EMAIL") {
    const email = await findHarveyEmailForTrackedLink(trackedLink.id);
    if (email) {
      await recordOutreachEvent({
        workspaceId: trackedLink.workspaceId,
        agentId: email.agentId,
        type: "LINK_CLICKED",
        emailHarveyId: email.harveyId,
        prospectHarveyId: email.prospect?.harveyId ?? null,
        trackedLinkSlug: slug,
        payload: { step: email.step },
      });
    }
  }

  // WhatsApp handoff links carry a {ref} placeholder until click time, because
  // the slug doesn't exist yet when the campaign is being built.
  return NextResponse.redirect(
    resolveRefPlaceholder(trackedLink.destinationUrl, slug),
    { status: 302 }
  );
}
