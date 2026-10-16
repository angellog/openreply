/**
 * Live status for each system.
 *
 * The registry says what a system is; this says whether it is actually doing
 * anything. The distinction matters because four of the five systems can be
 * perfectly configured and still be dead — a slept laptop, a logged-out
 * WhatsApp session, a worker that stopped — and none of that is visible from a
 * page of forms.
 *
 * Every probe is independent and wrapped: a system whose probe throws reports
 * that it could not be read, and the other four still render. A status page
 * that 500s because one count failed is worse than no status page.
 */

import { prisma } from "@/lib/db/client";
import { isEmailConfigured } from "@/lib/email/send";
import { AGENT_OFFLINE_AFTER_MS, EXPORTABLE_LEAD_WHERE } from "@/lib/harvey/sync";
import {
  SYSTEM_ORDER,
  SYSTEMS,
  type SystemId,
  type SystemDefinition,
} from "./registry";

export type SystemState =
  /** Configured, and something happened within the recent window. */
  | "live"
  /** Configured and healthy, but nothing has happened lately. */
  | "idle"
  /** Working, but something is wrong or waiting on the operator. */
  | "attention"
  /** Not usable yet: missing configuration or nothing created. */
  | "setup"
  /** The probe itself failed. Said out loud rather than guessed at. */
  | "unknown";

export interface SystemMetric {
  label: string;
  value: string;
}

export interface SystemStatus {
  id: SystemId;
  state: SystemState;
  /** One line under the system name. Always set, always specific. */
  summary: string;
  metrics: SystemMetric[];
  /** The single most useful thing to do next, when there is one. */
  nextStep: { label: string; href?: string } | null;
  /** Required env names that are not set. Names only — never values. */
  missingEnv: string[];
}

/** "Lately" for every system. One window, so the states are comparable. */
export const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function missingEnvFor(system: SystemDefinition): string[] {
  return system.requiredEnv.filter((name) => !process.env[name]);
}

function count(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

async function probeInstagram(
  workspaceId: string,
  since: Date
): Promise<Omit<SystemStatus, "id" | "missingEnv">> {
  const now = new Date();
  const [accounts, activeAutomations, totalAutomations, dmsRecent] =
    await Promise.all([
      prisma.instagramAccount.findMany({
        where: { workspaceId },
        select: {
          username: true,
          tokenExpiresAt: true,
          webhookSubscribed: true,
        },
      }),
      prisma.automation.count({ where: { workspaceId, isActive: true } }),
      prisma.automation.count({ where: { workspaceId } }),
      prisma.dmLog.count({
        where: { workspaceId, status: "SENT", createdAt: { gte: since } },
      }),
    ]);

  const metrics: SystemMetric[] = [
    { label: "Accounts", value: String(accounts.length) },
    { label: "Active campaigns", value: String(activeAutomations) },
    { label: "DMs sent (7d)", value: String(dmsRecent) },
  ];

  if (accounts.length === 0) {
    return {
      state: "setup",
      summary: "No Instagram account connected, so no comment can reach this.",
      metrics,
      nextStep: { label: "Connect an account", href: "/overview" },
    };
  }

  const expired = accounts.filter(
    (a) => a.tokenExpiresAt && a.tokenExpiresAt.getTime() <= now.getTime()
  );
  if (expired.length > 0) {
    return {
      state: "attention",
      summary: `${count(expired.length, "account")} needs reconnecting: @${expired
        .map((a) => a.username)
        .join(", @")}.`,
      metrics,
      nextStep: { label: "Reconnect", href: "/overview" },
    };
  }

  const unsubscribed = accounts.filter((a) => !a.webhookSubscribed);
  if (unsubscribed.length > 0) {
    return {
      state: "attention",
      summary: `${count(
        unsubscribed.length,
        "account"
      )} is not subscribed to comment webhooks, so Meta never tells us about new comments.`,
      metrics,
      nextStep: { label: "Check account health", href: "/overview" },
    };
  }

  if (totalAutomations === 0) {
    return {
      state: "setup",
      summary: "Accounts are connected, but there is no campaign to fire.",
      metrics,
      nextStep: { label: "Build a campaign", href: "/campaigns/new" },
    };
  }

  if (activeAutomations === 0) {
    return {
      state: "attention",
      summary: `${count(
        totalAutomations,
        "campaign"
      )} exists, but none is switched on.`,
      metrics,
      nextStep: { label: "Switch one on", href: "/campaigns" },
    };
  }

  if (dmsRecent > 0) {
    return {
      state: "live",
      summary: `${count(dmsRecent, "DM")} sent in the last 7 days.`,
      metrics,
      nextStep: null,
    };
  }

  return {
    state: "idle",
    summary:
      "Switched on and waiting. Nothing has matched a keyword in the last 7 days.",
    metrics,
    nextStep: { label: "Check the DM log", href: "/logs" },
  };
}

/**
 * Whether OpenWA is configured is settled before this runs: readSystemStatuses
 * short-circuits on missing requiredEnv, and this system's requiredEnv is the
 * same two variables isOpenWaConfigured() reads. So by the time we are here a
 * service is configured, and the only open question is whether anything has
 * come through it.
 */
async function probeWhatsApp(
  workspaceId: string,
  since: Date
): Promise<Omit<SystemStatus, "id" | "missingEnv">> {
  const [leadsRecent, leadsTotal, attributedRecent] = await Promise.all([
    prisma.whatsAppLead.count({ where: { workspaceId, createdAt: { gte: since } } }),
    prisma.whatsAppLead.count({ where: { workspaceId } }),
    prisma.whatsAppLead.count({
      where: { workspaceId, createdAt: { gte: since }, refSlug: { not: null } },
    }),
  ]);

  const metrics: SystemMetric[] = [
    { label: "Chats (7d)", value: String(leadsRecent) },
    { label: "Attributed (7d)", value: String(attributedRecent) },
    { label: "Chats, all time", value: String(leadsTotal) },
  ];

  if (leadsRecent > 0) {
    return {
      state: "live",
      summary: `${count(leadsRecent, "chat")} started in the last 7 days, ${attributedRecent} traced back to a specific link.`,
      metrics,
      nextStep: null,
    };
  }

  // Whether the WhatsApp Web session is still logged in can only be answered
  // by asking OpenWA, and that call can hang. A status probe must not, so this
  // says what it knows and sends the operator to the page that does ask.
  return {
    state: "idle",
    summary:
      leadsTotal > 0
        ? "Configured, but no chat in the last 7 days. Check the number is still connected."
        : "Configured. No chat has ever arrived — check a number is connected and scanned.",
    metrics,
    nextStep: { label: "Check numbers", href: "/whatsapp" },
  };
}

async function probeHarvey(
  workspaceId: string,
  since: Date
): Promise<Omit<SystemStatus, "id" | "missingEnv">> {
  const now = Date.now();
  const [agents, pendingReview, sentRecent, eventsRecent] = await Promise.all([
    prisma.harveyAgent.findMany({
      where: { workspaceId },
      select: {
        name: true,
        status: true,
        lastSeenAt: true,
        whatsappPhone: true,
        defaultDestinationUrl: true,
      },
    }),
    prisma.harveyEmail.count({ where: { workspaceId, status: "PENDING_REVIEW" } }),
    prisma.harveyEmail.count({
      where: { workspaceId, status: "SENT", sentAt: { gte: since } },
    }),
    prisma.outreachEvent.count({
      where: { workspaceId, createdAt: { gte: since } },
    }),
  ]);

  const active = agents.filter((a) => a.status === "ACTIVE");
  const metrics: SystemMetric[] = [
    { label: "Agents", value: String(active.length) },
    { label: "Waiting for you", value: String(pendingReview) },
    { label: "Sent (7d)", value: String(sentRecent) },
    { label: "Engagements (7d)", value: String(eventsRecent) },
  ];

  if (agents.length === 0) {
    return {
      state: "setup",
      summary:
        "No agent paired. An agent is the credential your Mac uses to prove it is yours.",
      metrics,
      nextStep: { label: "Create an agent", href: "/outreach" },
    };
  }

  if (active.length === 0) {
    return {
      state: "attention",
      summary: "Every agent is revoked, so no machine can sync.",
      metrics,
      nextStep: { label: "Review agents", href: "/outreach" },
    };
  }

  const neverSeen = active.filter((a) => !a.lastSeenAt);
  if (neverSeen.length === active.length) {
    return {
      state: "setup",
      summary:
        "The agent exists but Harvey has never checked in. The keys are probably not in Harvey's .env yet.",
      metrics,
      nextStep: { label: "Finish pairing", href: "/guide#harvey" },
    };
  }

  // Without a handoff Harvey cannot mint a tracked link, so every email it
  // writes has nothing to click. Ranked above pending approvals because
  // approving one in that state sends a dead end.
  const noHandoff = active.filter(
    (a) => !a.whatsappPhone && !a.defaultDestinationUrl
  );
  if (noHandoff.length > 0) {
    return {
      state: "attention",
      summary: `${noHandoff
        .map((a) => a.name)
        .join(", ")} has no handoff set, so its emails have nothing to click.`,
      metrics,
      nextStep: { label: "Set the handoff", href: "/outreach" },
    };
  }

  if (pendingReview > 0) {
    return {
      state: "attention",
      summary: `${count(
        pendingReview,
        "email"
      )} drafted and waiting for your yes or no.`,
      metrics,
      nextStep: { label: "Review the outbox", href: "/outreach" },
    };
  }

  const online = active.filter(
    (a) => a.lastSeenAt && now - a.lastSeenAt.getTime() < AGENT_OFFLINE_AFTER_MS
  );
  if (online.length === 0) {
    const latest = active
      .map((a) => a.lastSeenAt)
      .filter((d): d is Date => Boolean(d))
      .sort((a, b) => b.getTime() - a.getTime())[0];
    const hours = latest
      ? Math.round((now - latest.getTime()) / (60 * 60 * 1000))
      : null;
    return {
      state: "attention",
      summary:
        hours === null
          ? "Harvey has not checked in."
          : `Harvey last checked in about ${count(hours, "hour")} ago. Your Mac is probably asleep.`,
      metrics,
      nextStep: { label: "See how Harvey runs", href: "/guide#harvey" },
    };
  }

  if (sentRecent > 0 || eventsRecent > 0) {
    return {
      state: "live",
      summary: `Checked in within the hour. ${count(
        sentRecent,
        "email"
      )} sent and ${count(eventsRecent, "engagement")} recorded in 7 days.`,
      metrics,
      nextStep: null,
    };
  }

  return {
    state: "idle",
    summary:
      "Online with nothing to decide. Harvey is discovering companies or waiting on its daily send cap.",
    metrics,
    nextStep: null,
  };
}

async function probeResources(
  workspaceId: string,
  since: Date
): Promise<Omit<SystemStatus, "id" | "missingEnv">> {
  const [workspace, published, total, leadsRecent, consented, failedDelivery] =
    await Promise.all([
      prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: { publicSlug: true },
      }),
      prisma.resource.count({ where: { workspaceId, isPublished: true } }),
      prisma.resource.count({ where: { workspaceId } }),
      prisma.resourceLead.count({
        where: { workspaceId, createdAt: { gte: since } },
      }),
      // The sync's own rule, imported rather than restated. Spelled out here
      // it read "consented and not yet exported", which quietly counted leads
      // whose delivery email bounced — exactly the ones the export refuses,
      // because a mistyped address fed to a cold sequence is how a sending
      // domain earns a bad reputation. The map promised Harvey leads it would
      // never be given.
      prisma.resourceLead.count({
        where: { workspaceId, ...EXPORTABLE_LEAD_WHERE },
      }),
      prisma.resourceLead.count({
        where: { workspaceId, deliveryStatus: "FAILED" },
      }),
    ]);

  const metrics: SystemMetric[] = [
    { label: "Published", value: `${published} of ${total}` },
    { label: "Claims (7d)", value: String(leadsRecent) },
    { label: "Ready for Harvey", value: String(consented) },
  ];

  if (!isEmailConfigured()) {
    return {
      state: "setup",
      summary:
        "No mail transport, so a claimed resource cannot be delivered. Set EMAIL_SERVER or RESEND_API_KEY.",
      metrics,
      nextStep: { label: "See what is needed", href: "/guide#resources" },
    };
  }

  if (!workspace?.publicSlug) {
    return {
      state: "setup",
      summary: "No public brand slug, so the hub has no URL to share.",
      metrics,
      nextStep: { label: "Choose a slug", href: "/outreach/resources" },
    };
  }

  if (total === 0) {
    return {
      state: "setup",
      summary: "The hub exists but holds nothing yet.",
      metrics,
      nextStep: { label: "Add a resource", href: "/outreach/resources" },
    };
  }

  if (published === 0) {
    return {
      state: "attention",
      summary: `${count(
        total,
        "resource"
      )} written but none published, so the public page is empty.`,
      metrics,
      nextStep: { label: "Publish one", href: "/outreach/resources" },
    };
  }

  if (failedDelivery > 0) {
    return {
      state: "attention",
      summary: `${count(
        failedDelivery,
        "delivery"
      )} failed. Those addresses never got their link.`,
      metrics,
      nextStep: { label: "Review leads", href: "/outreach/resources" },
    };
  }

  if (leadsRecent > 0) {
    return {
      state: "live",
      summary: `${count(leadsRecent, "claim")} in the last 7 days, ${consented} consented and not yet handed to Harvey.`,
      metrics,
      nextStep: null,
    };
  }

  return {
    state: "idle",
    summary: `Live at /resources/${workspace.publicSlug} with nothing claimed in 7 days. It needs traffic.`,
    metrics,
    nextStep: { label: "Open the public hub", href: `/resources/${workspace.publicSlug}` },
  };
}

async function probePlatform(
  workspaceId: string,
  since: Date
): Promise<Omit<SystemStatus, "id" | "missingEnv">> {
  const [members, unresolvedErrors, recentEvents] = await Promise.all([
    prisma.workspaceMember.count({ where: { workspaceId } }),
    prisma.operationalEvent.count({
      where: {
        OR: [{ workspaceId }, { workspaceId: null }],
        level: "ERROR",
        resolvedAt: null,
        createdAt: { gte: since },
      },
    }),
    prisma.operationalEvent.count({
      where: {
        OR: [{ workspaceId }, { workspaceId: null }],
        createdAt: { gte: since },
      },
    }),
  ]);

  const metrics: SystemMetric[] = [
    { label: "Members", value: String(members) },
    { label: "Open errors", value: String(unresolvedErrors) },
    { label: "Events (7d)", value: String(recentEvents) },
  ];

  if (unresolvedErrors > 0) {
    return {
      state: "attention",
      summary: `${count(
        unresolvedErrors,
        "unresolved error"
      )} in the last 7 days.`,
      metrics,
      nextStep: { label: "Open diagnostics", href: "/diagnostics" },
    };
  }

  return {
    state: "live",
    summary: "No unresolved errors in the last 7 days.",
    metrics,
    nextStep: null,
  };
}

const PROBES: Record<
  SystemId,
  (
    workspaceId: string,
    since: Date
  ) => Promise<Omit<SystemStatus, "id" | "missingEnv">>
> = {
  instagram: probeInstagram,
  whatsapp: probeWhatsApp,
  harvey: probeHarvey,
  resources: probeResources,
  platform: probePlatform,
};

/**
 * Read every system's status. Missing required env short-circuits the probe:
 * counting rows for a system that cannot run tells the operator nothing, and
 * the fix is the same either way.
 */
export async function readSystemStatuses(
  workspaceId: string,
  now = new Date()
): Promise<SystemStatus[]> {
  const since = new Date(now.getTime() - RECENT_WINDOW_MS);

  return Promise.all(
    SYSTEM_ORDER.map(async (id): Promise<SystemStatus> => {
      const system = SYSTEMS[id];
      const missingEnv = missingEnvFor(system);

      if (missingEnv.length > 0) {
        return {
          id,
          state: "setup",
          summary: `Not configured: ${missingEnv.join(", ")} ${
            missingEnv.length === 1 ? "is" : "are"
          } not set.`,
          metrics: [],
          nextStep: { label: "See what is needed", href: `/guide#${id}` },
          missingEnv,
        };
      }

      try {
        const result = await PROBES[id](workspaceId, since);
        return { id, ...result, missingEnv };
      } catch (error) {
        // One failed count must not take the map down with it.
        return {
          id,
          state: "unknown",
          summary: `Status could not be read: ${
            error instanceof Error ? error.message : "unknown error"
          }`,
          metrics: [],
          nextStep: { label: "Open diagnostics", href: "/diagnostics" },
          missingEnv,
        };
      }
    })
  );
}

/** The worst state present, for the one-line summary in the top bar. */
export function worstState(statuses: SystemStatus[]): SystemState {
  const rank: SystemState[] = ["attention", "unknown", "setup", "idle", "live"];
  for (const state of rank) {
    if (statuses.some((s) => s.state === state)) return state;
  }
  return "live";
}
