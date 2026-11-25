/**
 * Campaign rules shared by every way a campaign gets made or changed.
 *
 * Two doors lead here: the dashboard (app/api/automations, cookie session) and
 * the service API (app/api/service/v1, bearer token, used by KickShot Studio).
 * Both must produce the same campaign from the same input — same validation,
 * same tracked links, same report slug, same dependent-field cleanup — or the
 * worker would treat a KickShot campaign differently from a hand-built one.
 * So the rules live once, here, and both routes call them.
 */

import { z } from "zod";
import type { Prisma } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";
import { calculateCtr, normalizeTopKeywords } from "@/lib/tracking/analytics";
import { generateTrackedLinkSlug } from "@/lib/tracking/server";
import { generateReportShareSlug } from "@/lib/reports/share";
import {
  isSignInCodeKeyword,
  SIGN_IN_CODE_KEYWORD_ERROR,
} from "@/lib/safety/sign-in-codes";

// ─── Field schemas ──────────────────────────────────────────────────────────

/** One keyword. Never one that would target the store's sign-in flow. */
const keywordSchema = z
  .string()
  .min(1)
  .max(50)
  .refine((keyword) => !isSignInCodeKeyword(keyword), {
    message: SIGN_IN_CODE_KEYWORD_ERROR,
  });

/** Empty string means "no link" (or "clear it" on update); a URL sets one. */
const destinationUrlSchema = z
  .union([z.string().url(), z.literal("")])
  .optional()
  .nullable();

/**
 * Every editable campaign field, without defaults. The dashboard schemas below
 * and the service API schema are all built from these, so a limit changed here
 * changes everywhere.
 */
export const campaignFields = {
  name: z.string().min(1).max(100),
  goal: z.string().min(1).max(120).optional().nullable(),
  postId: z.string().min(1).optional().nullable(),
  postUrl: z.string().url().optional().nullable(),
  keywords: z.array(keywordSchema).max(10),
  dmMessage: z.string().min(1).max(1000),
  openingDmMessage: z.string().max(1000).optional().nullable(),
  openingDmButtonLabel: z.string().max(64).optional().nullable(),
  linkButtonLabel: z.string().max(20).optional().nullable(),
  followPromptMessage: z.string().max(1000).optional().nullable(),
  followPromptButtonLabel: z.string().max(20).optional().nullable(),
  followUpMessage: z.string().max(1000).optional().nullable(),
  // Minutes to wait before the follow-up. Capped at 24h so it stays inside
  // Instagram's messaging window.
  followUpDelayMinutes: z.number().int().min(0).max(1440),
  publicReplyMessage: z.string().max(1000).optional().nullable(),
  publicReplyMessages: z.array(z.string().max(1000)).max(10),
  trackedDestinationUrl: destinationUrlSchema,
  // Optional second tracked link, rendered as a second DM button.
  secondaryDestinationUrl: destinationUrlSchema,
  secondaryButtonLabel: z.string().max(20).optional().nullable(),
} as const;

export const createAutomationSchema = z
  .object({
    name: campaignFields.name,
    goal: campaignFields.goal,
    instagramAccountId: z.string().min(1).optional().nullable(),
    postId: campaignFields.postId,
    postUrl: campaignFields.postUrl,
    pendingNextReel: z.boolean().optional().default(false),
    matchAnyPost: z.boolean().optional().default(false),
    keywords: campaignFields.keywords.optional().default([]),
    matchAnyWord: z.boolean().optional().default(false),
    dmTriggerEnabled: z.boolean().optional().default(false),
    dmMessage: campaignFields.dmMessage,
    openingDmEnabled: z.boolean().optional().default(false),
    openingDmMessage: campaignFields.openingDmMessage,
    openingDmButtonLabel: campaignFields.openingDmButtonLabel,
    linkButtonLabel: campaignFields.linkButtonLabel,
    requireFollow: z.boolean().optional().default(false),
    followPromptMessage: campaignFields.followPromptMessage,
    followPromptButtonLabel: campaignFields.followPromptButtonLabel,
    followUpEnabled: z.boolean().optional().default(false),
    followUpMessage: campaignFields.followUpMessage,
    followUpDelayMinutes: campaignFields.followUpDelayMinutes.optional().default(0),
    publicReplyEnabled: z.boolean().optional().default(false),
    publicReplyMessage: campaignFields.publicReplyMessage,
    publicReplyMessages: campaignFields.publicReplyMessages.optional().default([]),
    trackedDestinationUrl: campaignFields.trackedDestinationUrl,
    secondaryDestinationUrl: campaignFields.secondaryDestinationUrl,
    secondaryButtonLabel: campaignFields.secondaryButtonLabel,
    isActive: z.boolean().optional().default(true),
    wholeWordMatch: z.boolean().optional().default(true),
  })
  // A campaign must target a specific post, any post, or the next reel.
  .refine(
    (d) => d.matchAnyPost || d.pendingNextReel || Boolean(d.postId),
    { message: "Choose which post(s) trigger the campaign", path: ["postId"] }
  )
  // And it must match either specific words or any word.
  .refine((d) => d.matchAnyWord || d.keywords.length >= 1, {
    message: "Add at least one keyword, or match any word",
    path: ["keywords"],
  })
  // An opening DM needs both a message and a button label.
  .refine(
    (d) =>
      !d.openingDmEnabled ||
      (Boolean(d.openingDmMessage?.trim()) &&
        Boolean(d.openingDmButtonLabel?.trim())),
    { message: "Opening DM needs a message and a button label", path: ["openingDmMessage"] }
  );

export const updateAutomationSchema = z.object({
  name: campaignFields.name.optional(),
  goal: campaignFields.goal,
  postId: campaignFields.postId,
  postUrl: campaignFields.postUrl,
  pendingNextReel: z.boolean().optional(),
  matchAnyPost: z.boolean().optional(),
  keywords: campaignFields.keywords.optional(),
  matchAnyWord: z.boolean().optional(),
  dmTriggerEnabled: z.boolean().optional(),
  dmMessage: campaignFields.dmMessage.optional(),
  openingDmEnabled: z.boolean().optional(),
  openingDmMessage: campaignFields.openingDmMessage,
  openingDmButtonLabel: campaignFields.openingDmButtonLabel,
  linkButtonLabel: campaignFields.linkButtonLabel,
  requireFollow: z.boolean().optional(),
  followPromptMessage: campaignFields.followPromptMessage,
  followPromptButtonLabel: campaignFields.followPromptButtonLabel,
  followUpEnabled: z.boolean().optional(),
  followUpMessage: campaignFields.followUpMessage,
  followUpDelayMinutes: campaignFields.followUpDelayMinutes.optional(),
  publicReplyEnabled: z.boolean().optional(),
  publicReplyMessage: campaignFields.publicReplyMessage,
  publicReplyMessages: campaignFields.publicReplyMessages.optional(),
  isActive: z.boolean().optional(),
  wholeWordMatch: z.boolean().optional(),
  reportShareEnabled: z.boolean().optional(),
  // Empty string clears the tracked link; a URL updates/creates it; undefined
  // leaves it unchanged.
  trackedDestinationUrl: campaignFields.trackedDestinationUrl,
  // Same semantics for the optional second tracked link / DM button.
  secondaryDestinationUrl: campaignFields.secondaryDestinationUrl,
  secondaryButtonLabel: campaignFields.secondaryButtonLabel,
});

export type CreateAutomationInput = z.infer<typeof createAutomationSchema>;
export type UpdateAutomationInput = z.infer<typeof updateAutomationSchema>;

export interface CampaignLinkInput {
  trackedDestinationUrl?: string | null;
  secondaryDestinationUrl?: string | null;
  secondaryButtonLabel?: string | null;
}

// ─── Creating ───────────────────────────────────────────────────────────────

const PRIMARY_LINK_LABEL = "Primary campaign link";
const DEFAULT_SECONDARY_LABEL = "Open link";

/**
 * The tracked links a new campaign starts with. The primary link's button
 * title comes from `linkButtonLabel`; the second link stores its own button
 * title in the tracked link's `label` field.
 */
export function buildTrackedLinkCreates(
  workspaceId: string,
  { trackedDestinationUrl, secondaryDestinationUrl, secondaryButtonLabel }: CampaignLinkInput
) {
  const linkCreates: {
    workspaceId: string;
    slug: string;
    label: string;
    destinationUrl: string;
  }[] = [];
  if (trackedDestinationUrl) {
    linkCreates.push({
      workspaceId,
      slug: generateTrackedLinkSlug(),
      label: PRIMARY_LINK_LABEL,
      destinationUrl: trackedDestinationUrl,
    });
  }
  if (secondaryDestinationUrl) {
    linkCreates.push({
      workspaceId,
      slug: generateTrackedLinkSlug(),
      label: secondaryButtonLabel?.trim() || DEFAULT_SECONDARY_LABEL,
      destinationUrl: secondaryDestinationUrl,
    });
  }
  return linkCreates;
}

/** Trimmed, non-empty public-reply variations, falling back to the legacy single field. */
export function normalizePublicReplyList(
  messages: string[],
  single: string | null | undefined
): string[] {
  return (messages.length > 0 ? messages : single ? [single] : [])
    .map((m) => m.trim())
    .filter(Boolean);
}

/**
 * The full create payload for a validated campaign: dependent fields cleared,
 * tracked links minted, report slug assigned.
 */
export function buildAutomationCreateData(
  data: CreateAutomationInput,
  target: { workspaceId: string; instagramAccountId: string; externalRef?: string | null }
): Prisma.AutomationUncheckedCreateInput {
  const { workspaceId, instagramAccountId } = target;
  const { pendingNextReel, matchAnyPost, matchAnyWord, openingDmEnabled } = data;
  // A post is only stored for the "specific post" trigger.
  const isSpecificPost = !pendingNextReel && !matchAnyPost;
  const publicReplyList = normalizePublicReplyList(
    data.publicReplyMessages,
    data.publicReplyMessage
  );
  const linkCreates = buildTrackedLinkCreates(workspaceId, data);

  return {
    name: data.name,
    goal: data.goal,
    // A next-reel campaign has no post yet; the cron binds it once a reel is posted.
    postId: isSpecificPost ? data.postId : null,
    postUrl: isSpecificPost ? data.postUrl : null,
    pendingNextReel,
    matchAnyPost,
    keywords: matchAnyWord ? [] : data.keywords,
    matchAnyWord,
    dmTriggerEnabled: data.dmTriggerEnabled,
    dmMessage: data.dmMessage,
    openingDmEnabled,
    openingDmMessage: openingDmEnabled ? data.openingDmMessage || null : null,
    openingDmButtonLabel: openingDmEnabled
      ? data.openingDmButtonLabel || null
      : null,
    linkButtonLabel: data.linkButtonLabel || null,
    requireFollow: data.requireFollow,
    followPromptMessage: data.requireFollow
      ? data.followPromptMessage || null
      : null,
    followPromptButtonLabel: data.requireFollow
      ? data.followPromptButtonLabel || null
      : null,
    followUpEnabled: data.followUpEnabled,
    followUpMessage: data.followUpEnabled ? data.followUpMessage || null : null,
    followUpDelayMinutes: data.followUpEnabled ? data.followUpDelayMinutes : 0,
    publicReplyEnabled: data.publicReplyEnabled,
    publicReplyMessages: data.publicReplyEnabled ? publicReplyList : [],
    publicReplyMessage: data.publicReplyEnabled
      ? publicReplyList[0] ?? data.publicReplyMessage ?? null
      : null,
    isActive: data.isActive,
    wholeWordMatch: data.wholeWordMatch,
    workspaceId,
    instagramAccountId,
    externalRef: target.externalRef ?? null,
    reportShareSlug: generateReportShareSlug(),
    ...(linkCreates.length > 0
      ? { trackedLinks: { create: linkCreates } }
      : {}),
  };
}

// ─── Updating ───────────────────────────────────────────────────────────────

export type AutomationFieldUpdate = Omit<
  UpdateAutomationInput,
  keyof CampaignLinkInput
>;

/**
 * Keep dependent fields consistent on a partial update: any-word clears
 * keywords; a disabled opening DM, follow gate or follow-up clears its text;
 * any-post / next-reel campaigns carry no specific post; the public-reply
 * variations list and the legacy single field stay in sync. Mutates and
 * returns `data`.
 */
export function normalizeAutomationUpdate<T extends AutomationFieldUpdate>(data: T): T {
  if (data.matchAnyWord === true) data.keywords = [];
  if (data.openingDmEnabled === false) {
    data.openingDmMessage = null;
    data.openingDmButtonLabel = null;
  }
  if (data.requireFollow === false) {
    data.followPromptMessage = null;
    data.followPromptButtonLabel = null;
  }
  if (data.followUpEnabled === false) {
    data.followUpMessage = null;
    data.followUpDelayMinutes = 0;
  }
  if (data.matchAnyPost === true || data.pendingNextReel === true) {
    data.postId = null;
    data.postUrl = null;
  }
  if (data.publicReplyMessages !== undefined) {
    const list = data.publicReplyMessages.map((m) => m.trim()).filter(Boolean);
    data.publicReplyMessages = list;
    data.publicReplyMessage = list[0] ?? null;
  }
  if (data.publicReplyEnabled === false) {
    data.publicReplyMessages = [];
    data.publicReplyMessage = null;
  }
  return data;
}

/**
 * Update, create, or clear a campaign's tracked links. For each link,
 * `undefined`/`null` leaves it alone, `""` deletes it, and a URL updates the
 * existing link (keeping its slug, so links already sent keep working) or
 * creates one. The primary link is the oldest; the second link is index [1]
 * and its `label` holds the second button's title.
 */
export async function syncCampaignTrackedLinks(
  workspaceId: string,
  automationId: string,
  { trackedDestinationUrl, secondaryDestinationUrl, secondaryButtonLabel }: CampaignLinkInput
): Promise<void> {
  if (trackedDestinationUrl !== undefined && trackedDestinationUrl !== null) {
    const primaryLink = await prisma.trackedLink.findFirst({
      where: { automationId },
      orderBy: { createdAt: "asc" },
    });

    if (trackedDestinationUrl === "") {
      if (primaryLink) {
        await prisma.trackedLink.delete({ where: { id: primaryLink.id } });
      }
    } else if (primaryLink) {
      await prisma.trackedLink.update({
        where: { id: primaryLink.id },
        data: { destinationUrl: trackedDestinationUrl },
      });
    } else {
      await prisma.trackedLink.create({
        data: {
          workspaceId,
          automationId,
          slug: generateTrackedLinkSlug(),
          label: PRIMARY_LINK_LABEL,
          destinationUrl: trackedDestinationUrl,
        },
      });
    }
  }

  if (secondaryDestinationUrl !== undefined && secondaryDestinationUrl !== null) {
    const links = await prisma.trackedLink.findMany({
      where: { automationId },
      orderBy: { createdAt: "asc" },
    });
    const secondaryLink = links[1];
    const secondaryLabel = secondaryButtonLabel?.trim() || DEFAULT_SECONDARY_LABEL;

    if (secondaryDestinationUrl === "") {
      if (secondaryLink) {
        await prisma.trackedLink.delete({ where: { id: secondaryLink.id } });
      }
    } else if (secondaryLink) {
      await prisma.trackedLink.update({
        where: { id: secondaryLink.id },
        data: { destinationUrl: secondaryDestinationUrl, label: secondaryLabel },
      });
    } else {
      await prisma.trackedLink.create({
        data: {
          workspaceId,
          automationId,
          slug: generateTrackedLinkSlug(),
          label: secondaryLabel,
          destinationUrl: secondaryDestinationUrl,
        },
      });
    }
  }
}

// ─── Reports and stats ──────────────────────────────────────────────────────

/** Campaigns made before shareable reports existed get a slug on first read. */
export async function ensureReportShareSlug<
  T extends { id: string; reportShareSlug: string | null },
>(automation: T): Promise<T> {
  if (automation.reportShareSlug) return automation;
  const updated = await prisma.automation.update({
    where: { id: automation.id },
    data: { reportShareSlug: generateReportShareSlug() },
    select: { reportShareSlug: true },
  });
  return { ...automation, reportShareSlug: updated.reportShareSlug };
}

export interface CampaignStats {
  sent: number;
  skipped: number;
  failed: number;
  clicks: number;
  /** Clicks over sends, as a percentage capped at 100. */
  ctr: number;
  topKeywords: { keyword: string; count: number }[];
  /** WhatsApp chats attributed to this campaign through its tracked link. */
  whatsappLeads: number;
  /** When the most recent DM was actually delivered. */
  lastDmAt: Date | null;
}

export function emptyCampaignStats(): CampaignStats {
  return {
    sent: 0,
    skipped: 0,
    failed: 0,
    clicks: 0,
    ctr: 0,
    topKeywords: [],
    whatsappLeads: 0,
    lastDmAt: null,
  };
}

/**
 * Outcome counts for a set of campaigns, in six grouped queries regardless of
 * how many campaigns there are. Every id passed in gets an entry, zeroed when
 * the campaign has no activity yet.
 */
export async function getCampaignStats(
  workspaceId: string,
  automationIds: string[]
): Promise<Map<string, CampaignStats>> {
  const stats = new Map<string, CampaignStats>();
  for (const id of automationIds) stats.set(id, emptyCampaignStats());
  if (automationIds.length === 0) return stats;

  const scope = { workspaceId, automationId: { in: automationIds } };

  const [statusCounts, clickCounts, keywordCounts, leadCounts, lastSent] =
    await Promise.all([
      prisma.dmLog.groupBy({
        by: ["automationId", "status"],
        where: scope,
        _count: { _all: true },
      }),
      prisma.linkClick.groupBy({
        by: ["automationId"],
        where: scope,
        _count: { _all: true },
      }),
      prisma.dmLog.groupBy({
        by: ["automationId", "matchedKeyword"],
        where: { ...scope, matchedKeyword: { not: null } },
        _count: { _all: true },
      }),
      prisma.whatsAppLead.groupBy({
        by: ["automationId"],
        where: scope,
        _count: { _all: true },
      }),
      prisma.dmLog.groupBy({
        by: ["automationId"],
        where: { ...scope, status: "SENT" },
        _max: { dmSentAt: true },
      }),
    ]);

  for (const row of statusCounts) {
    const item = stats.get(row.automationId);
    if (!item) continue;
    const count = row._count._all;
    if (row.status === "SENT") item.sent += count;
    if (row.status === "FAILED") item.failed += count;
    if (row.status.startsWith("SKIPPED_")) item.skipped += count;
  }

  for (const row of clickCounts) {
    // A click on a link that isn't an Instagram campaign's (a Harvey cold
    // email, say) has no automation to attribute to.
    if (!row.automationId) continue;
    const item = stats.get(row.automationId);
    if (item) item.clicks = row._count._all;
  }

  for (const row of leadCounts) {
    if (!row.automationId) continue;
    const item = stats.get(row.automationId);
    if (item) item.whatsappLeads = row._count._all;
  }

  for (const row of lastSent) {
    const item = stats.get(row.automationId);
    if (item) item.lastDmAt = row._max.dmSentAt ?? null;
  }

  for (const [id, item] of stats) {
    item.topKeywords = normalizeTopKeywords(
      keywordCounts
        .filter((row) => row.automationId === id)
        .map((row) => ({
          matchedKeyword: row.matchedKeyword,
          _count: row._count._all,
        })),
      3
    );
    item.ctr = calculateCtr(item.clicks, item.sent);
  }

  return stats;
}
