/**
 * The sync payload: what Harvey pushes, and what it gets back.
 *
 * One request per heartbeat carries three things at once — the rows Harvey
 * learned about, the acks for commands it already applied, and (in the
 * response) the commands it has not seen yet. Folding all three into one call
 * means a heartbeat is a single round trip, and it makes the ordering obvious:
 * Harvey's work is recorded before new orders are handed out.
 *
 * Every row is keyed by Harvey's own id, so re-sending a batch after a network
 * failure updates the same rows instead of duplicating them.
 */

import { z } from "zod";

/** A single sync must stay bounded; a first run after a big discover could
 *  otherwise try to push thousands of rows in one body. Matches MAX_BATCH in
 *  harvey/integrations/openreply.py. */
export const MAX_BATCH = 200;

const harveyId = z.string().min(1).max(64);
const shortText = z.string().max(500).nullish();

export const harveyCompanyInput = z.object({
  harveyId,
  name: z.string().max(300).default(""),
  domain: shortText,
  website: shortText,
  industry: shortText,
  location: shortText,
  sourceUrl: shortText,
});

export const harveyProspectInput = z.object({
  harveyId,
  companyHarveyId: z.string().max(64).nullish(),
  firstName: shortText,
  lastName: shortText,
  email: z.string().max(320),
  emailStatus: z.enum(["verified", "risky", "guess", "invalid"]).nullish(),
  title: shortText,
  status: z.string().max(40).nullish(),
  score: z.number().int().min(0).max(100).nullish(),
  personalizationNotes: z.string().max(4000).nullish(),
});

/** Harvey's five outbox statuses, lower case as they appear in its SQLite. */
export const harveyEmailStatusInput = z.enum([
  "pending_review",
  "approved",
  "sent",
  "failed",
  "cancelled",
]);

export const harveyEmailInput = z.object({
  harveyId,
  prospectHarveyId: z.string().max(64).nullish(),
  campaignHarveyId: z.string().max(64).nullish(),
  step: z.number().int().min(1).max(20).default(1),
  kind: z.string().max(20).default("sequence"),
  toEmail: z.string().max(320),
  subject: z.string().max(500).default(""),
  body: z.string().max(20000).default(""),
  status: harveyEmailStatusInput.default("pending_review"),
  sendAt: z.string().datetime({ offset: true }).nullish(),
  sentAt: z.string().datetime({ offset: true }).nullish(),
  error: z.string().max(2000).nullish(),
});

export const harveySyncRequest = z.object({
  /** What is running on the operator's machine, for the diagnostics page. */
  runtime: z
    .object({
      version: z.string().max(40).nullish(),
      brainProvider: z.string().max(20).nullish(),
    })
    .optional(),
  /** Commands Harvey has applied since the last sync. */
  acks: z
    .array(
      z.object({
        commandId: z.string().min(1).max(64),
        result: z.string().max(200).default("ok"),
      })
    )
    .max(MAX_BATCH)
    .optional(),
  /** Resource leads the agent has taken as prospects, by their OpenReply id. */
  leadAcks: z.array(z.string().min(1).max(64)).max(MAX_BATCH).optional(),
  /**
   * Highest event seq this agent has applied. The agent keeps the cursor, not
   * the server: an agent that loses its database can replay from 0, and every
   * handler on its side is idempotent so replaying costs nothing but time.
   */
  eventCursor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  companies: z.array(harveyCompanyInput).max(MAX_BATCH).optional(),
  prospects: z.array(harveyProspectInput).max(MAX_BATCH).optional(),
  emails: z.array(harveyEmailInput).max(MAX_BATCH).optional(),
});

export type HarveySyncRequest = z.infer<typeof harveySyncRequest>;

export const EMAIL_STATUS_TO_DB = {
  pending_review: "PENDING_REVIEW",
  approved: "APPROVED",
  sent: "SENT",
  failed: "FAILED",
  cancelled: "CANCELLED",
} as const;

/** Commands are only worth applying for so long: a three-day-old approval
 *  should not fire the moment a sleeping laptop wakes up. */
export const COMMAND_TTL_MS = 72 * 60 * 60 * 1000;

/** A PENDING_REVIEW email older than this was written against observations
 *  that have since moved on, so the UI asks for a fresh look. */
export const EMAIL_STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/** How long after its last request an agent is treated as offline. A laptop
 *  that slept for three days looks identical to a crashed one, so the only
 *  honest thing to show is how long ago it last spoke. Read by both the agents
 *  route and the systems status probe — one threshold, so the agent card and
 *  the systems map can never disagree about whether Harvey is up. */
export const AGENT_OFFLINE_AFTER_MS = 60 * 60 * 1000;

export function isEmailStale(
  status: string,
  createdAt: Date,
  now: Date = new Date()
): boolean {
  return (
    status === "PENDING_REVIEW" &&
    now.getTime() - createdAt.getTime() > EMAIL_STALE_AFTER_MS
  );
}

/**
 * A resource lead is only ever offered to the outbound agent when all three of
 * these hold. Each one is doing work:
 *
 * - consentMarketing: they ticked the box. Without it the address was given for
 *   one download and nothing else, and sending to it is spam whatever the law
 *   in a given country says.
 * - deliveryStatus SENT: the copy we emailed was accepted. An address that
 *   failed is junk or mistyped, and feeding it to a cold sequence is how a
 *   sending domain earns a bad reputation.
 * - exportedAt null: offered exactly once.
 */
export const EXPORTABLE_LEAD_WHERE = {
  consentMarketing: true,
  deliveryStatus: "SENT",
  exportedAt: null,
} as const;
