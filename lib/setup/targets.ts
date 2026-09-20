/**
 * Targets: what the Setup Console calls the things OpenReply watches.
 *
 * A target is one `Automation` row — an Instagram account, the post or posts to
 * watch, the keywords that trigger it, and what gets sent back. The dashboard
 * calls these "campaigns"; the console calls them targets because during setup
 * you are thinking about *where to point this thing*, not about marketing.
 * Same records, same table, so anything added here shows up in the dashboard
 * and vice versa.
 */

import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { generateReportShareSlug } from "@/lib/reports/share";
import { generateTrackedLinkSlug } from "@/lib/tracking/server";
import { buildTrackedUrl } from "@/lib/tracking/message";

/** Which posts a target listens to. */
export type TargetTrigger = "specific_post" | "any_post" | "next_reel";

export const targetInputSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    instagramAccountId: z.string().trim().min(1),
    trigger: z.enum(["specific_post", "any_post", "next_reel"]),
    postId: z.string().trim().min(1).max(64).optional().nullable(),
    postUrl: z.string().trim().url().optional().nullable().or(z.literal("")),
    keywords: z.array(z.string().trim().min(1).max(50)).max(10).default([]),
    matchAnyWord: z.boolean().default(false),
    wholeWordMatch: z.boolean().default(true),
    dmMessage: z.string().trim().min(1).max(1000),
    publicReplyEnabled: z.boolean().default(false),
    publicReplyMessages: z.array(z.string().trim().max(1000)).max(10).default([]),
    trackedDestinationUrl: z
      .union([z.string().trim().url(), z.literal("")])
      .optional()
      .nullable(),
    isActive: z.boolean().default(true),
  })
  .refine((value) => value.trigger !== "specific_post" || Boolean(value.postId), {
    message: "Pick a post, or switch the trigger to any post / next reel",
    path: ["postId"],
  })
  .refine((value) => value.matchAnyWord || value.keywords.length > 0, {
    message: "Add at least one keyword, or turn on match-any-word",
    path: ["keywords"],
  })
  .refine(
    (value) =>
      !value.publicReplyEnabled ||
      value.publicReplyMessages.some((message) => message.trim().length > 0),
    {
      message: "A public reply needs at least one message",
      path: ["publicReplyMessages"],
    }
  );

export type TargetInput = z.infer<typeof targetInputSchema>;

export const targetPatchSchema = z.object({
  isActive: z.boolean().optional(),
  name: z.string().trim().min(1).max(100).optional(),
});

/**
 * Fold the trigger enum back into the three flags the `Automation` row stores.
 * Keeping this in one place is what stops a target from ending up with, say,
 * both `matchAnyPost` and a `postId` set — a combination the worker would read
 * as "any post" while the UI showed a specific one.
 */
export function triggerToFields(trigger: TargetTrigger, postId?: string | null, postUrl?: string | null) {
  return {
    matchAnyPost: trigger === "any_post",
    pendingNextReel: trigger === "next_reel",
    postId: trigger === "specific_post" ? (postId ?? null) : null,
    postUrl: trigger === "specific_post" ? (postUrl || null) : null,
  };
}

export function fieldsToTrigger(row: {
  matchAnyPost: boolean;
  pendingNextReel: boolean;
}): TargetTrigger {
  if (row.matchAnyPost) return "any_post";
  if (row.pendingNextReel) return "next_reel";
  return "specific_post";
}

export const TRIGGER_LABELS: Record<TargetTrigger, string> = {
  specific_post: "One specific post",
  any_post: "Any post on the account",
  next_reel: "The next reel posted",
};

export interface TargetSummary {
  id: string;
  name: string;
  trigger: TargetTrigger;
  triggerLabel: string;
  postId: string | null;
  postUrl: string | null;
  keywords: string[];
  matchAnyWord: boolean;
  wholeWordMatch: boolean;
  dmMessage: string;
  publicReplyEnabled: boolean;
  publicReplyMessages: string[];
  isActive: boolean;
  createdAt: string;
  account: { id: string; username: string; instagramId: string } | null;
  trackedUrl: string | null;
  trackedDestinationUrl: string | null;
  stats: { sent: number; failed: number; skipped: number };
}

/** Pull an Instagram media ID out of a post URL, when one is embedded. */
export function extractPostIdFromUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  // A bare numeric media ID pasted straight from the Graph API.
  if (/^\d{5,}$/.test(trimmed)) return trimmed;
  // Otherwise the shortcode from a /p/ or /reel/ permalink. It is not the media
  // ID, but it is a stable handle the post picker can resolve against.
  const shortcode = trimmed.match(/instagram\.com\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/);
  return shortcode?.[1] ?? null;
}

export async function listTargets(workspaceId: string): Promise<TargetSummary[]> {
  const automations = await prisma.automation.findMany({
    where: { workspaceId },
    orderBy: { createdAt: "desc" },
    include: {
      instagramAccount: {
        select: { id: true, username: true, instagramId: true },
      },
      trackedLinks: {
        select: { slug: true, destinationUrl: true },
        orderBy: { createdAt: "asc" },
        take: 1,
      },
    },
  });

  const statusCounts = await prisma.dmLog.groupBy({
    by: ["automationId", "status"],
    where: { workspaceId },
    _count: { _all: true },
  });

  const stats = new Map<string, { sent: number; failed: number; skipped: number }>();
  for (const row of statusCounts) {
    const entry = stats.get(row.automationId) ?? { sent: 0, failed: 0, skipped: 0 };
    if (row.status === "SENT") entry.sent += row._count._all;
    else if (row.status === "FAILED") entry.failed += row._count._all;
    else if (row.status.startsWith("SKIPPED_")) entry.skipped += row._count._all;
    stats.set(row.automationId, entry);
  }

  return automations.map((automation) => {
    const trigger = fieldsToTrigger(automation);
    const link = automation.trackedLinks[0] ?? null;

    return {
      id: automation.id,
      name: automation.name,
      trigger,
      triggerLabel: TRIGGER_LABELS[trigger],
      postId: automation.postId,
      postUrl: automation.postUrl,
      keywords: automation.keywords,
      matchAnyWord: automation.matchAnyWord,
      wholeWordMatch: automation.wholeWordMatch,
      dmMessage: automation.dmMessage,
      publicReplyEnabled: automation.publicReplyEnabled,
      publicReplyMessages: automation.publicReplyMessages,
      isActive: automation.isActive,
      createdAt: automation.createdAt.toISOString(),
      account: automation.instagramAccount
        ? {
            id: automation.instagramAccount.id,
            username: automation.instagramAccount.username,
            instagramId: automation.instagramAccount.instagramId,
          }
        : null,
      trackedUrl: link ? buildTrackedUrl(link.slug) : null,
      trackedDestinationUrl: link?.destinationUrl ?? null,
      stats: stats.get(automation.id) ?? { sent: 0, failed: 0, skipped: 0 },
    };
  });
}

export async function createTarget(workspaceId: string, input: TargetInput) {
  const account = await prisma.instagramAccount.findFirst({
    where: { id: input.instagramAccountId, workspaceId },
    select: { id: true },
  });

  if (!account) {
    throw new TargetError(
      "That Instagram account is not connected to this workspace.",
      400
    );
  }

  const publicReplies = input.publicReplyEnabled
    ? input.publicReplyMessages.map((message) => message.trim()).filter(Boolean)
    : [];

  return prisma.automation.create({
    data: {
      workspaceId,
      instagramAccountId: account.id,
      name: input.name,
      ...triggerToFields(input.trigger, input.postId, input.postUrl),
      keywords: input.matchAnyWord ? [] : input.keywords,
      matchAnyWord: input.matchAnyWord,
      wholeWordMatch: input.wholeWordMatch,
      dmMessage: input.dmMessage,
      publicReplyEnabled: input.publicReplyEnabled,
      publicReplyMessages: publicReplies,
      publicReplyMessage: publicReplies[0] ?? null,
      isActive: input.isActive,
      reportShareSlug: generateReportShareSlug(),
      ...(input.trackedDestinationUrl
        ? {
            trackedLinks: {
              create: {
                workspaceId,
                slug: generateTrackedLinkSlug(),
                label: "Primary campaign link",
                destinationUrl: input.trackedDestinationUrl,
              },
            },
          }
        : {}),
    },
    include: { trackedLinks: true },
  });
}

export async function patchTarget(
  workspaceId: string,
  targetId: string,
  patch: z.infer<typeof targetPatchSchema>
) {
  const existing = await prisma.automation.findFirst({
    where: { id: targetId, workspaceId },
    select: { id: true },
  });
  if (!existing) throw new TargetError("Target not found.", 404);

  return prisma.automation.update({ where: { id: targetId }, data: patch });
}

export async function deleteTarget(workspaceId: string, targetId: string) {
  const existing = await prisma.automation.findFirst({
    where: { id: targetId, workspaceId },
    select: { id: true },
  });
  if (!existing) throw new TargetError("Target not found.", 404);

  await prisma.automation.delete({ where: { id: targetId } });
}

export class TargetError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "TargetError";
  }
}
