/**
 * Recording what happened after an email went out.
 *
 * Harvey can read its own mailbox and nothing else. A click lands here, and a
 * WhatsApp reply lands here. Without this stream it keeps sending step 3 to
 * someone who already answered on WhatsApp, which is the worst thing an
 * outbound sequence can do.
 *
 * Writing an event must never break the thing that caused it. A redirect still
 * redirects and a WhatsApp reply still sends if this fails; the event is lost
 * and that is the correct trade.
 */

import { prisma } from "@/lib/db/client";
import type { OutreachEventType, Prisma } from "@/app/generated/prisma/client";

type RecordArgs = {
  workspaceId: string;
  type: OutreachEventType;
  agentId?: string | null;
  prospectHarveyId?: string | null;
  emailHarveyId?: string | null;
  trackedLinkSlug?: string | null;
  payload?: Prisma.InputJsonValue;
};

export async function recordOutreachEvent(args: RecordArgs): Promise<void> {
  await prisma.outreachEvent
    .create({
      data: {
        workspaceId: args.workspaceId,
        type: args.type,
        agentId: args.agentId ?? null,
        prospectHarveyId: args.prospectHarveyId ?? null,
        emailHarveyId: args.emailHarveyId ?? null,
        trackedLinkSlug: args.trackedLinkSlug ?? null,
        payload: args.payload ?? undefined,
      },
    })
    .catch(() => undefined);
}

/**
 * The email a tracked link belongs to, when it belongs to one at all.
 *
 * Returns null for an Instagram campaign's link, which is most of them: this
 * lookup is the thing that decides whether a click is worth telling an agent
 * about.
 */
export async function findHarveyEmailForTrackedLink(trackedLinkId: string) {
  return prisma.harveyEmail.findFirst({
    where: { trackedLinkId },
    select: {
      harveyId: true,
      agentId: true,
      step: true,
      prospect: { select: { harveyId: true, email: true } },
    },
  });
}

/**
 * How long an agent may fall behind before the stream is trimmed for it.
 *
 * Events are only useful while they are actionable. A click from six weeks ago
 * tells a sequence nothing it can still act on, and keeping an unbounded
 * backlog for an agent that never comes back would mean replaying weeks of
 * history the first time it does.
 */
export const EVENT_RETENTION_DAYS = 30;

/**
 * Events after a cursor, oldest first.
 *
 * The `createdAt` guard is not decoration. Postgres hands out sequence numbers
 * before a transaction commits, so two concurrent inserts can become visible
 * out of order: a reader that takes the highest seq it sees could skip a lower
 * one that commits a moment later. Ignoring the last couple of seconds lets
 * those settle, and costs a reader nothing because it polls on a minute.
 */
export const EVENT_SETTLE_MS = 2000;

export async function readOutreachEvents({
  agentId,
  workspaceId,
  since,
  limit = 100,
  now = new Date(),
}: {
  agentId: string;
  workspaceId: string;
  since: number;
  limit?: number;
  now?: Date;
}) {
  return prisma.outreachEvent.findMany({
    where: {
      workspaceId,
      // Events with no agent (a resource download before anyone claimed the
      // lead) are offered to every agent in the workspace; each one decides
      // whether it knows that address.
      OR: [{ agentId }, { agentId: null }],
      seq: { gt: since },
      createdAt: { lt: new Date(now.getTime() - EVENT_SETTLE_MS) },
    },
    orderBy: { seq: "asc" },
    take: Math.min(limit, 200),
    select: {
      seq: true,
      type: true,
      prospectHarveyId: true,
      emailHarveyId: true,
      trackedLinkSlug: true,
      payload: true,
      createdAt: true,
    },
  });
}
