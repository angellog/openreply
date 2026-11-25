/**
 * Campaigns as the service API sees them.
 *
 * A machine client (KickShot Studio) names each campaign with its own
 * `externalRef`, e.g. "kickshot:<run>:<page>", and never needs OpenReply's ids.
 * Creating is idempotent on that ref, so a client that retries after a timeout
 * gets the same campaign back instead of a second one firing the same DM.
 *
 * Lifecycle KickShot follows:
 *   1. POST /campaigns before publishing: the campaign exists, inactive, with
 *      no post. It cannot fire — the worker only matches active campaigns
 *      bound to the commented post.
 *   2. PATCH /campaigns/:ref with { postId, postUrl } once the reel is live:
 *      the post is attached and the campaign switches on.
 *   3. PATCH { isActive: false } to pause, GET for stats.
 *
 * Validation, tracked links, report slugs and stats come from
 * lib/automations/campaign.ts, the same code the dashboard uses.
 */

import { z } from "zod";
import { prisma } from "@/lib/db/client";
import {
  buildAutomationCreateData,
  campaignFields,
  emptyCampaignStats,
  ensureReportShareSlug,
  getCampaignStats,
  normalizeAutomationUpdate,
  syncCampaignTrackedLinks,
  type CampaignStats,
  type CreateAutomationInput,
} from "@/lib/automations/campaign";
import { buildTrackedUrl } from "@/lib/tracking/message";
import { buildReportUrl } from "@/lib/reports/share";
import { getCurrentDMCount, RATE_LIMIT_MAX } from "@/lib/utils/rate-limiter";

// ─── Input ──────────────────────────────────────────────────────────────────

/**
 * Printable, URL-path-safe characters only, so a ref round-trips through
 * /campaigns/:externalRef without escaping surprises. Covers
 * "kickshot:2026-11-25T10:00:feetbit.sneakers" and "kickshot:run_42:@page".
 */
export const EXTERNAL_REF_PATTERN = /^[A-Za-z0-9._:@+=~-]+$/;
export const EXTERNAL_REF_MAX = 120;

export const externalRefSchema = z
  .string()
  .trim()
  .min(1, "externalRef is required")
  .max(EXTERNAL_REF_MAX, `externalRef must be at most ${EXTERNAL_REF_MAX} characters`)
  .regex(
    EXTERNAL_REF_PATTERN,
    "externalRef may contain only letters, digits and . _ : @ + = ~ -"
  );

/** Fields a client may set on create and change afterwards. */
const editableFields = {
  name: campaignFields.name,
  keywords: campaignFields.keywords.min(1, "Add at least one keyword"),
  dmMessage: campaignFields.dmMessage,
  linkButtonLabel: campaignFields.linkButtonLabel,
  trackedDestinationUrl: campaignFields.trackedDestinationUrl,
  secondaryDestinationUrl: campaignFields.secondaryDestinationUrl,
  secondaryButtonLabel: campaignFields.secondaryButtonLabel,
  publicReplyEnabled: z.boolean().optional(),
  publicReplyMessages: campaignFields.publicReplyMessages.optional(),
  requireFollow: z.boolean().optional(),
  dmTriggerEnabled: z.boolean().optional(),
  followUpEnabled: z.boolean().optional(),
  followUpMessage: campaignFields.followUpMessage,
  followUpDelayMinutes: campaignFields.followUpDelayMinutes.optional(),
  postId: campaignFields.postId,
  postUrl: campaignFields.postUrl,
  isActive: z.boolean().optional(),
};

export const serviceCreateSchema = z.object({
  externalRef: externalRefSchema,
  instagramUsername: z.string().trim().min(1).max(64),
  ...editableFields,
});

export const serviceUpdateSchema = z.object({
  name: editableFields.name.optional(),
  keywords: editableFields.keywords.optional(),
  dmMessage: editableFields.dmMessage.optional(),
  linkButtonLabel: editableFields.linkButtonLabel,
  trackedDestinationUrl: editableFields.trackedDestinationUrl,
  secondaryDestinationUrl: editableFields.secondaryDestinationUrl,
  secondaryButtonLabel: editableFields.secondaryButtonLabel,
  publicReplyEnabled: editableFields.publicReplyEnabled,
  publicReplyMessages: editableFields.publicReplyMessages,
  requireFollow: editableFields.requireFollow,
  dmTriggerEnabled: editableFields.dmTriggerEnabled,
  followUpEnabled: editableFields.followUpEnabled,
  followUpMessage: editableFields.followUpMessage,
  followUpDelayMinutes: editableFields.followUpDelayMinutes,
  postId: editableFields.postId,
  postUrl: editableFields.postUrl,
  isActive: editableFields.isActive,
});

export type ServiceCreateInput = z.infer<typeof serviceCreateSchema>;
export type ServiceUpdateInput = z.infer<typeof serviceUpdateSchema>;

/** Zod issues flattened into something a client can log in one line each. */
export function formatIssues(error: z.ZodError) {
  return error.issues.slice(0, 20).map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
  }));
}

/** A failure the route turns into a JSON error response. */
export class ServiceCampaignError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly extra: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = "ServiceCampaignError";
  }
}

// ─── Accounts ───────────────────────────────────────────────────────────────

export function normalizeUsername(username: string): string {
  return username.trim().replace(/^@+/, "").toLowerCase();
}

interface AccountRow {
  id: string;
  instagramId: string;
  username: string;
  accessToken: string;
  tokenExpiresAt: Date | null;
  webhookSubscribed: boolean;
}

/** A stored token that has not expired. Disconnecting deletes the row outright. */
export function isAccountConnected(account: Pick<AccountRow, "accessToken" | "tokenExpiresAt">, now = new Date()) {
  return (
    Boolean(account.accessToken) &&
    (account.tokenExpiresAt === null || account.tokenExpiresAt > now)
  );
}

const ACCOUNT_SELECT = {
  id: true,
  instagramId: true,
  username: true,
  accessToken: true,
  tokenExpiresAt: true,
  webhookSubscribed: true,
} as const;

/** How many of Meta's 750 private replies an hour each account has used. Null if Redis cannot say. */
async function readPrivateReplyUsage(instagramIds: string[]): Promise<Map<string, number | null>> {
  const usage = new Map<string, number | null>();
  if (!process.env.REDIS_URL) {
    for (const id of instagramIds) usage.set(id, null);
    return usage;
  }
  await Promise.all(
    instagramIds.map(async (id) => {
      const count = await Promise.race([
        getCurrentDMCount(id).catch(() => null),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 250)),
      ]);
      usage.set(id, count);
    })
  );
  return usage;
}

export async function listServiceAccounts(workspaceId: string) {
  const accounts = await prisma.instagramAccount.findMany({
    where: { workspaceId },
    select: ACCOUNT_SELECT,
    orderBy: { connectedAt: "asc" },
  });
  const usage = await readPrivateReplyUsage(accounts.map((a) => a.instagramId));
  const now = new Date();

  return accounts.map((account) => {
    const connected = isAccountConnected(account, now);
    const used = usage.get(account.instagramId) ?? null;
    const remaining = used === null ? null : Math.max(0, RATE_LIMIT_MAX - used);
    return {
      id: account.id,
      username: account.username,
      connected,
      tokenExpiresAt: account.tokenExpiresAt?.toISOString() ?? null,
      // Sending needs a live token, Meta delivering the comment webhook, and
      // room left in this hour's private-reply allowance.
      canPrivateReply:
        connected && account.webhookSubscribed && (remaining === null || remaining > 0),
      webhookSubscribed: account.webhookSubscribed,
      privateReplyLimitPerHour: RATE_LIMIT_MAX,
      privateRepliesUsedThisHour: used,
      privateRepliesRemainingThisHour: remaining,
    };
  });
}

/** The workspace's account for a username, or a 422 that says what to do. */
export async function resolveConnectedAccount(
  workspaceId: string,
  instagramUsername: string
): Promise<AccountRow> {
  const wanted = normalizeUsername(instagramUsername);
  const accounts = await prisma.instagramAccount.findMany({
    where: { workspaceId },
    select: ACCOUNT_SELECT,
  });
  const account = accounts.find((a) => normalizeUsername(a.username) === wanted);
  const connectedList = accounts
    .filter((a) => isAccountConnected(a))
    .map((a) => `@${a.username}`);

  if (!account) {
    throw new ServiceCampaignError(
      422,
      "UNKNOWN_ACCOUNT",
      `No Instagram account @${wanted} is connected to this workspace. ` +
        `Connected: ${connectedList.length ? connectedList.join(", ") : "none"}. ` +
        "Connect it in the OpenReply dashboard (Connect Instagram), then retry.",
      { instagramUsername: wanted, connectedAccounts: connectedList }
    );
  }
  if (!isAccountConnected(account)) {
    throw new ServiceCampaignError(
      422,
      "ACCOUNT_NOT_CONNECTED",
      `@${account.username} is in this workspace but its Instagram token ` +
        (account.tokenExpiresAt
          ? `expired at ${account.tokenExpiresAt.toISOString()}`
          : "is missing") +
        ". Reconnect it in the OpenReply dashboard, then retry.",
      { instagramUsername: account.username }
    );
  }
  return account;
}

// ─── Output ─────────────────────────────────────────────────────────────────

const CAMPAIGN_INCLUDE = {
  instagramAccount: { select: { username: true } },
  trackedLinks: {
    select: { slug: true, label: true, destinationUrl: true },
    orderBy: { createdAt: "asc" as const },
  },
};

type CampaignRow = NonNullable<
  Awaited<ReturnType<typeof findCampaign>>
>;

function findCampaign(workspaceId: string, externalRef: string) {
  return prisma.automation.findUnique({
    where: { workspaceId_externalRef: { workspaceId, externalRef } },
    include: CAMPAIGN_INCLUDE,
  });
}

export function serializeStats(stats: CampaignStats) {
  return {
    dmsSent: stats.sent,
    dmsSkipped: stats.skipped,
    dmsFailed: stats.failed,
    linkClicks: stats.clicks,
    ctr: stats.ctr,
    whatsappLeads: stats.whatsappLeads,
    lastDmAt: stats.lastDmAt?.toISOString() ?? null,
  };
}

export function serializeCampaign(row: CampaignRow, stats: CampaignStats) {
  const [primary, secondary] = row.trackedLinks;
  return {
    externalRef: row.externalRef as string,
    id: row.id,
    name: row.name,
    instagramAccountId: row.instagramAccountId,
    instagramUsername: row.instagramAccount.username,
    keywords: row.keywords,
    dmMessage: row.dmMessage,
    linkButtonLabel: row.linkButtonLabel,
    trackedDestinationUrl: primary?.destinationUrl ?? null,
    trackedUrl: primary ? buildTrackedUrl(primary.slug) : null,
    secondaryDestinationUrl: secondary?.destinationUrl ?? null,
    secondaryButtonLabel: secondary?.label ?? null,
    secondaryTrackedUrl: secondary ? buildTrackedUrl(secondary.slug) : null,
    publicReplyEnabled: row.publicReplyEnabled,
    publicReplyMessages: row.publicReplyMessages,
    requireFollow: row.requireFollow,
    dmTriggerEnabled: row.dmTriggerEnabled,
    followUpEnabled: row.followUpEnabled,
    followUpMessage: row.followUpMessage,
    followUpDelayMinutes: row.followUpDelayMinutes,
    postId: row.postId,
    postUrl: row.postUrl,
    isActive: row.isActive,
    reportUrl: row.reportShareSlug ? buildReportUrl(row.reportShareSlug) : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    stats: serializeStats(stats),
  };
}

export type ServiceCampaign = ReturnType<typeof serializeCampaign>;

async function loadSerialized(workspaceId: string, externalRef: string) {
  const row = await findCampaign(workspaceId, externalRef);
  if (!row) return null;
  const withSlug = await ensureReportShareSlug(row);
  const stats = await getCampaignStats(workspaceId, [row.id]);
  return serializeCampaign(withSlug, stats.get(row.id) ?? emptyCampaignStats());
}

export async function getServiceCampaign(workspaceId: string, externalRef: string) {
  return loadSerialized(workspaceId, externalRef);
}

export const LIST_LIMIT_DEFAULT = 100;
export const LIST_LIMIT_MAX = 500;

export async function listServiceCampaigns(
  workspaceId: string,
  options: { prefix?: string | null; instagramUsername?: string | null; limit?: number }
) {
  const rows = await prisma.automation.findMany({
    where: {
      workspaceId,
      // Only campaigns a machine client made; dashboard campaigns have no ref.
      externalRef: options.prefix ? { startsWith: options.prefix } : { not: null },
      ...(options.instagramUsername
        ? {
            instagramAccount: {
              username: {
                equals: normalizeUsername(options.instagramUsername),
                mode: "insensitive" as const,
              },
            },
          }
        : {}),
    },
    include: CAMPAIGN_INCLUDE,
    orderBy: { createdAt: "desc" },
    take: options.limit ?? LIST_LIMIT_DEFAULT,
  });
  const withSlugs = await Promise.all(rows.map((row) => ensureReportShareSlug(row)));
  const stats = await getCampaignStats(
    workspaceId,
    rows.map((row) => row.id)
  );
  return withSlugs.map((row) =>
    serializeCampaign(row, stats.get(row.id) ?? emptyCampaignStats())
  );
}

// ─── Writing ────────────────────────────────────────────────────────────────

function assertActivatable(isActive: boolean, postId: string | null | undefined) {
  if (isActive && !postId) {
    throw new ServiceCampaignError(
      422,
      "POST_REQUIRED",
      "A campaign can only be active once a post is attached. Send postId (and postUrl) with isActive: true, or attach the post with PATCH /api/service/v1/campaigns/:externalRef after publishing."
    );
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}

/**
 * Applies a partial update to an existing service campaign. Only keys present
 * in `input` change; the rest keep their stored values.
 */
async function applyUpdate(
  workspaceId: string,
  existing: CampaignRow,
  input: ServiceUpdateInput
): Promise<void> {
  const {
    trackedDestinationUrl,
    secondaryDestinationUrl: secondaryUrlInput,
    secondaryButtonLabel,
    ...fields
  } = input;

  const finalPostId = fields.postId !== undefined ? fields.postId : existing.postId;
  const finalActive = fields.isActive !== undefined ? fields.isActive : existing.isActive;
  assertActivatable(finalActive, finalPostId);

  normalizeAutomationUpdate(fields);

  // A new button label on its own still renames the existing second link.
  const existingSecondary = existing.trackedLinks[1];
  const secondaryDestinationUrl =
    secondaryUrlInput === undefined && secondaryButtonLabel != null && existingSecondary
      ? existingSecondary.destinationUrl
      : secondaryUrlInput;

  if (Object.keys(fields).length > 0) {
    await prisma.automation.update({ where: { id: existing.id }, data: fields });
  }
  await syncCampaignTrackedLinks(workspaceId, existing.id, {
    trackedDestinationUrl,
    secondaryDestinationUrl,
    secondaryButtonLabel,
  });
}

function toCreateInput(
  input: ServiceCreateInput,
  instagramAccountId: string
): CreateAutomationInput {
  return {
    name: input.name,
    goal: null,
    instagramAccountId,
    postId: input.postId ?? null,
    postUrl: input.postUrl ?? null,
    // Service campaigns always target one specific post, attached by PATCH.
    pendingNextReel: false,
    matchAnyPost: false,
    keywords: input.keywords,
    matchAnyWord: false,
    dmTriggerEnabled: input.dmTriggerEnabled ?? false,
    dmMessage: input.dmMessage,
    openingDmEnabled: false,
    openingDmMessage: null,
    openingDmButtonLabel: null,
    linkButtonLabel: input.linkButtonLabel ?? null,
    requireFollow: input.requireFollow ?? false,
    followPromptMessage: null,
    followPromptButtonLabel: null,
    followUpEnabled: input.followUpEnabled ?? false,
    followUpMessage: input.followUpMessage ?? null,
    followUpDelayMinutes: input.followUpDelayMinutes ?? 0,
    publicReplyEnabled: input.publicReplyEnabled ?? false,
    publicReplyMessage: null,
    publicReplyMessages: input.publicReplyMessages ?? [],
    trackedDestinationUrl: input.trackedDestinationUrl,
    secondaryDestinationUrl: input.secondaryDestinationUrl,
    secondaryButtonLabel: input.secondaryButtonLabel,
    // Off until a post is attached, unless the caller already has one.
    isActive: input.isActive ?? false,
    wholeWordMatch: true,
  };
}

function assertSameAccount(existing: CampaignRow, instagramUsername: string) {
  if (normalizeUsername(existing.instagramAccount.username) !== normalizeUsername(instagramUsername)) {
    throw new ServiceCampaignError(
      409,
      "EXTERNAL_REF_CONFLICT",
      `externalRef "${existing.externalRef}" already belongs to a campaign on @${existing.instagramAccount.username}, not @${normalizeUsername(instagramUsername)}. Use a ref that includes the page.`
    );
  }
}

/**
 * Create, or — when the ref already exists — update and return the existing
 * campaign. Never creates a duplicate, including under concurrent retries.
 */
export async function upsertServiceCampaign(
  workspaceId: string,
  input: ServiceCreateInput
): Promise<{ campaign: ServiceCampaign; created: boolean }> {
  const { externalRef, instagramUsername, ...editable } = input;

  const existing = await findCampaign(workspaceId, externalRef);
  if (existing) {
    assertSameAccount(existing, instagramUsername);
    await applyUpdate(workspaceId, existing, editable);
    return { campaign: (await loadSerialized(workspaceId, externalRef))!, created: false };
  }

  const account = await resolveConnectedAccount(workspaceId, instagramUsername);
  const createInput = toCreateInput(input, account.id);
  assertActivatable(createInput.isActive, createInput.postId);

  try {
    await prisma.automation.create({
      data: buildAutomationCreateData(createInput, {
        workspaceId,
        instagramAccountId: account.id,
        externalRef,
      }),
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    // A concurrent request with the same ref won the race. Treat this one as
    // the retry it is: update the campaign that now exists.
    const winner = await findCampaign(workspaceId, externalRef);
    if (!winner) throw error;
    assertSameAccount(winner, instagramUsername);
    await applyUpdate(workspaceId, winner, editable);
    return { campaign: (await loadSerialized(workspaceId, externalRef))!, created: false };
  }

  return { campaign: (await loadSerialized(workspaceId, externalRef))!, created: true };
}

/**
 * PATCH semantics: attaching a post switches the campaign on unless the caller
 * says otherwise; detaching it switches the campaign off.
 */
export async function updateServiceCampaign(
  workspaceId: string,
  externalRef: string,
  input: ServiceUpdateInput
): Promise<ServiceCampaign | null> {
  const existing = await findCampaign(workspaceId, externalRef);
  if (!existing) return null;

  const update = { ...input };
  if (update.isActive === undefined && update.postId !== undefined) {
    update.isActive = Boolean(update.postId);
  }
  if (update.postId === null && update.postUrl === undefined) update.postUrl = null;

  await applyUpdate(workspaceId, existing, update);
  return loadSerialized(workspaceId, externalRef);
}

/** A path segment back to a ref. Valid refs never contain "%", so decode only if one does. */
export function decodeExternalRefParam(raw: string): string {
  if (!raw.includes("%")) return raw;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
