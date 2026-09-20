/**
 * Readiness checks behind the Setup Console.
 *
 * Every check answers one question a person actually asks while setting this up
 * ("is the worker running?", "will Meta be able to reach me?") and, when the
 * answer is no, says what to do about it. A check never throws: a thrown check
 * would take the whole console down at exactly the moment it is most needed.
 */

import { promises as fs } from "fs";
import path from "path";
import { prisma } from "@/lib/db/client";
import { getDMQueue, getRedisConnection } from "@/lib/queue/client";
import { getWorkerHealth } from "@/lib/ops/worker-health";
import { ENV_FIELDS, validateFieldValue, warnAboutFieldValue } from "@/lib/setup/fields";

export type CheckStatus = "ok" | "warn" | "error" | "skipped";

export interface SetupCheck {
  id: string;
  label: string;
  status: CheckStatus;
  /** One line describing what was found. */
  detail: string;
  /** What to do about it, when the status is not ok. */
  remedy?: string;
  /** A shell command that would fix or diagnose it. */
  command?: string;
  meta?: Record<string, unknown>;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

/** Wrap a check so a thrown error becomes a failed check, not a failed page. */
async function safely(
  id: string,
  label: string,
  run: () => Promise<SetupCheck>
): Promise<SetupCheck> {
  try {
    return await run();
  } catch (error) {
    return {
      id,
      label,
      status: "error",
      detail: errorMessage(error, "Check failed unexpectedly"),
    };
  }
}

// ─── Environment ────────────────────────────────────────────────────────────

export function checkEnvironment(values: Record<string, string>): SetupCheck {
  const missing: string[] = [];
  const invalid: string[] = [];
  const warnings: string[] = [];

  for (const field of ENV_FIELDS) {
    const value = (values[field.name] ?? "").trim();
    if (!value) {
      if (field.required) missing.push(field.name);
      continue;
    }
    if (validateFieldValue(field.name, value)) invalid.push(field.name);
    else if (warnAboutFieldValue(field.name, value)) warnings.push(field.name);
  }

  if (missing.length > 0 || invalid.length > 0) {
    const parts = [
      missing.length > 0 ? `${missing.length} required value(s) missing` : null,
      invalid.length > 0 ? `${invalid.length} malformed` : null,
    ].filter(Boolean);
    return {
      id: "env",
      label: "Environment",
      status: "error",
      detail: parts.join(", "),
      remedy: `Fill these in on the Environment tab: ${[...missing, ...invalid].join(", ")}`,
      meta: { missing, invalid, warnings },
    };
  }

  if (warnings.length > 0) {
    return {
      id: "env",
      label: "Environment",
      status: "warn",
      detail: `All required values set, ${warnings.length} worth a second look`,
      remedy: `Check these on the Environment tab: ${warnings.join(", ")}`,
      meta: { missing, invalid, warnings },
    };
  }

  return {
    id: "env",
    label: "Environment",
    status: "ok",
    detail: "Every required variable is set and well-formed",
    meta: { missing, invalid, warnings },
  };
}

// ─── Datastores ─────────────────────────────────────────────────────────────

export async function checkDatabase(): Promise<SetupCheck> {
  return safely("database", "PostgreSQL", async () => {
    if (!process.env.DATABASE_URL) {
      return {
        id: "database",
        label: "PostgreSQL",
        status: "error",
        detail: "DATABASE_URL is not set",
        remedy: "Set DATABASE_URL on the Environment tab.",
      };
    }

    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch (error) {
      return {
        id: "database",
        label: "PostgreSQL",
        status: "error",
        detail: errorMessage(error, "Could not connect"),
        remedy:
          "Start Postgres and confirm DATABASE_URL points at it. With Docker: docker-compose up -d. With Homebrew: brew services start postgresql@16.",
        command: "docker-compose up -d",
      };
    }

    return {
      id: "database",
      label: "PostgreSQL",
      status: "ok",
      detail: "Connected",
    };
  });
}

export async function checkMigrations(): Promise<SetupCheck> {
  return safely("migrations", "Database schema", async () => {
    let onDisk: string[] = [];
    try {
      const entries = await fs.readdir(
        path.join(process.cwd(), "prisma", "migrations"),
        { withFileTypes: true }
      );
      onDisk = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch {
      onDisk = [];
    }

    let applied: { migration_name: string; finished_at: Date | null }[];
    try {
      applied = await prisma.$queryRawUnsafe<
        { migration_name: string; finished_at: Date | null }[]
      >(`SELECT migration_name, finished_at FROM "_prisma_migrations"`);
    } catch {
      return {
        id: "migrations",
        label: "Database schema",
        status: "error",
        detail: "No migration history table — the schema has never been applied",
        remedy: "Create the tables by running the migrations.",
        command: "npm run db:migrate",
      };
    }

    const appliedNames = new Set(
      applied.filter((row) => row.finished_at !== null).map((row) => row.migration_name)
    );
    const pending = onDisk.filter((name) => !appliedNames.has(name));

    if (pending.length > 0) {
      return {
        id: "migrations",
        label: "Database schema",
        status: "error",
        detail: `${pending.length} migration(s) pending: ${pending.join(", ")}`,
        remedy: "Apply the outstanding migrations.",
        command: "npm run db:migrate",
        meta: { pending },
      };
    }

    return {
      id: "migrations",
      label: "Database schema",
      status: "ok",
      detail: `${appliedNames.size} migration(s) applied, none pending`,
    };
  });
}

export async function checkRedis(): Promise<SetupCheck> {
  return safely("redis", "Redis", async () => {
    if (!process.env.REDIS_URL) {
      return {
        id: "redis",
        label: "Redis",
        status: "error",
        detail: "REDIS_URL is not set",
        remedy: "Set REDIS_URL on the Environment tab.",
      };
    }

    try {
      const pong = await getRedisConnection().ping();
      if (pong !== "PONG") {
        return {
          id: "redis",
          label: "Redis",
          status: "error",
          detail: `Unexpected PING reply: ${pong}`,
        };
      }
    } catch (error) {
      return {
        id: "redis",
        label: "Redis",
        status: "error",
        detail: errorMessage(error, "Could not connect"),
        remedy:
          "Start Redis and confirm REDIS_URL points at it. Note that BullMQ needs blocking commands, so an HTTP-only Redis will not work.",
        command: "docker-compose up -d",
      };
    }

    return { id: "redis", label: "Redis", status: "ok", detail: "Connected" };
  });
}

export async function checkQueue(): Promise<SetupCheck> {
  return safely("queue", "Send queue", async () => {
    const counts = await getDMQueue().getJobCounts(
      "waiting",
      "active",
      "delayed",
      "failed"
    );
    const failed = counts.failed ?? 0;

    return {
      id: "queue",
      label: "Send queue",
      status: failed > 0 ? "warn" : "ok",
      detail:
        failed > 0
          ? `${failed} failed job(s), ${counts.waiting ?? 0} waiting`
          : `${counts.waiting ?? 0} waiting, ${counts.active ?? 0} active`,
      remedy: failed > 0 ? "Open Diagnostics to see why the sends failed." : undefined,
      meta: { counts },
    };
  });
}

export async function checkWorker(): Promise<SetupCheck> {
  return safely("worker", "DM worker", async () => {
    const health = await getWorkerHealth();

    if (!health.heartbeat) {
      return {
        id: "worker",
        label: "DM worker",
        status: "error",
        detail: "No heartbeat — the worker is not running",
        remedy:
          "The web app receives comments but never sends DMs on its own. Start the worker in a second terminal and leave it running.",
        command: "npm run worker",
      };
    }

    if (!health.healthy) {
      const ageSeconds = Math.round((health.ageMs ?? 0) / 1000);
      return {
        id: "worker",
        label: "DM worker",
        status: "error",
        detail: `Last heartbeat ${ageSeconds}s ago — the worker has stopped`,
        remedy: "Restart the worker process.",
        command: "npm run worker",
      };
    }

    return {
      id: "worker",
      label: "DM worker",
      status: "ok",
      detail: `Running (pid ${health.heartbeat.pid}${
        health.heartbeat.hostname ? ` on ${health.heartbeat.hostname}` : ""
      })`,
      meta: { heartbeat: health.heartbeat },
    };
  });
}

// ─── External services ──────────────────────────────────────────────────────

export async function checkResend(): Promise<SetupCheck> {
  return safely("resend", "Login email (Resend)", async () => {
    const apiKey = process.env.RESEND_API_KEY?.trim();
    if (!apiKey) {
      return {
        id: "resend",
        label: "Login email (Resend)",
        status: "warn",
        detail: "No API key — magic-link sign-in is unavailable",
        remedy:
          "Add RESEND_API_KEY to let people sign in by email. For local work you can skip this and use the local sign-in on the Sign in tab.",
      };
    }

    const response = await fetch("https://api.resend.com/domains", {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(8000),
    }).catch((error: unknown) => error as Error);

    if (response instanceof Error) {
      return {
        id: "resend",
        label: "Login email (Resend)",
        status: "warn",
        detail: `Could not reach Resend: ${response.message}`,
      };
    }

    if (response.status === 401 || response.status === 403) {
      return {
        id: "resend",
        label: "Login email (Resend)",
        status: "error",
        detail: "Resend rejected the API key",
        remedy: "Generate a fresh key at resend.com/api-keys and paste it in.",
      };
    }

    if (!response.ok) {
      return {
        id: "resend",
        label: "Login email (Resend)",
        status: "warn",
        detail: `Resend replied ${response.status}`,
      };
    }

    const payload = (await response.json().catch(() => null)) as {
      data?: { name: string; status: string }[];
    } | null;
    const domains = payload?.data ?? [];
    const verified = domains.filter((domain) => domain.status === "verified");
    const from = process.env.EMAIL_FROM ?? "";
    const fromDomain = from.match(/@([^\s>]+)/)?.[1]?.toLowerCase() ?? null;

    if (verified.length === 0) {
      return {
        id: "resend",
        label: "Login email (Resend)",
        status: "warn",
        detail: "Key works, but no verified sending domain",
        remedy:
          "Verify a domain in Resend, then set EMAIL_FROM to an address on it. Until then magic links will not be delivered.",
        meta: { domains },
      };
    }

    if (fromDomain && !verified.some((domain) => domain.name.toLowerCase() === fromDomain)) {
      return {
        id: "resend",
        label: "Login email (Resend)",
        status: "warn",
        detail: `EMAIL_FROM uses ${fromDomain}, which is not a verified domain`,
        remedy: `Set EMAIL_FROM to an address on one of: ${verified
          .map((domain) => domain.name)
          .join(", ")}`,
        meta: { domains },
      };
    }

    return {
      id: "resend",
      label: "Login email (Resend)",
      status: "ok",
      detail: `Key valid, sending from a verified domain (${verified
        .map((domain) => domain.name)
        .join(", ")})`,
      meta: { domains },
    };
  });
}

/**
 * Can Meta actually deliver a webhook here?
 *
 * There is no Meta API that answers this, so the check is structural: a
 * localhost or private-network public URL is a hard no, and anything else gets
 * an actual round-trip against its own /api/health.
 */
export async function checkPublicReachability(): Promise<SetupCheck> {
  return safely("reachability", "Public reachability", async () => {
    const baseUrl = process.env.NEXTAUTH_URL?.trim();
    if (!baseUrl) {
      return {
        id: "reachability",
        label: "Public reachability",
        status: "error",
        detail: "NEXTAUTH_URL is not set",
        remedy: "Set NEXTAUTH_URL on the Environment tab.",
      };
    }

    let parsed: URL;
    try {
      parsed = new URL(baseUrl);
    } catch {
      return {
        id: "reachability",
        label: "Public reachability",
        status: "error",
        detail: "NEXTAUTH_URL is not a valid URL",
      };
    }

    const isLocal =
      /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)$/i.test(parsed.hostname) ||
      /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(parsed.hostname) ||
      parsed.hostname.endsWith(".local");

    if (isLocal) {
      return {
        id: "reachability",
        label: "Public reachability",
        status: "warn",
        detail: `${parsed.origin} is only reachable from this machine`,
        remedy:
          "Fine while you build the dashboard, but Meta cannot post webhooks here. Expose it with a tunnel and set NEXTAUTH_URL to the tunnel URL before connecting Instagram.",
        command: "npx untun@latest tunnel http://localhost:3000",
        meta: { local: true },
      };
    }

    const response = await fetch(`${parsed.origin}/api/health`, {
      signal: AbortSignal.timeout(8000),
      cache: "no-store",
    }).catch((error: unknown) => error as Error);

    if (response instanceof Error) {
      return {
        id: "reachability",
        label: "Public reachability",
        status: "error",
        detail: `${parsed.origin} did not respond: ${response.message}`,
        remedy:
          "Meta needs to reach this URL. Confirm the deployment is live and that NEXTAUTH_URL matches its real address.",
      };
    }

    // /api/health returns 503 when degraded, which still proves reachability.
    return {
      id: "reachability",
      label: "Public reachability",
      status: "ok",
      detail: `${parsed.origin} answered (HTTP ${response.status})`,
      meta: { local: false, status: response.status },
    };
  });
}

/**
 * Round-trip the webhook verification handshake against ourselves, exactly the
 * way Meta does it. This catches a WEBHOOK_VERIFY_TOKEN that does not match what
 * the running process has loaded — the single most common reason Meta's "Verify
 * and save" button fails.
 */
export async function checkWebhookVerification(origin: string): Promise<SetupCheck> {
  return safely("webhook", "Webhook handshake", async () => {
    const token = process.env.WEBHOOK_VERIFY_TOKEN?.trim();
    if (!token) {
      return {
        id: "webhook",
        label: "Webhook handshake",
        status: "error",
        detail: "WEBHOOK_VERIFY_TOKEN is not set",
        remedy: "Generate one on the Environment tab.",
      };
    }

    const challenge = `openreply-${Date.now()}`;
    const url = new URL("/api/webhook", origin);
    url.searchParams.set("hub.mode", "subscribe");
    url.searchParams.set("hub.verify_token", token);
    url.searchParams.set("hub.challenge", challenge);

    const response = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      cache: "no-store",
    }).catch((error: unknown) => error as Error);

    if (response instanceof Error) {
      return {
        id: "webhook",
        label: "Webhook handshake",
        status: "error",
        detail: `Could not call the webhook endpoint: ${response.message}`,
      };
    }

    const body = await response.text().catch(() => "");
    if (response.status === 200 && body === challenge) {
      return {
        id: "webhook",
        label: "Webhook handshake",
        status: "ok",
        detail: "The endpoint echoed the challenge — Meta's verification will pass",
      };
    }

    return {
      id: "webhook",
      label: "Webhook handshake",
      status: "error",
      detail: `Endpoint replied ${response.status} instead of echoing the challenge`,
      remedy:
        "The running server has a different WEBHOOK_VERIFY_TOKEN than the one on disk. Restart the dev server so it picks up the saved .env.",
      command: "npm run dev",
    };
  });
}

export async function checkInstagramAccounts(): Promise<SetupCheck> {
  return safely("instagram", "Connected Instagram accounts", async () => {
    const accounts = await prisma.instagramAccount.findMany({
      select: {
        username: true,
        webhookSubscribed: true,
        tokenExpiresAt: true,
      },
      orderBy: { connectedAt: "desc" },
    });

    if (accounts.length === 0) {
      return {
        id: "instagram",
        label: "Connected Instagram accounts",
        status: "warn",
        detail: "None connected yet",
        remedy:
          "Finish the Meta app steps, then connect an account from the Targets tab. It must be a Business or Creator account.",
      };
    }

    const unsubscribed = accounts.filter((account) => !account.webhookSubscribed);
    const now = Date.now();
    const expiring = accounts.filter(
      (account) =>
        account.tokenExpiresAt &&
        account.tokenExpiresAt.getTime() - now < 7 * 24 * 60 * 60 * 1000
    );

    if (unsubscribed.length > 0) {
      return {
        id: "instagram",
        label: "Connected Instagram accounts",
        status: "warn",
        detail: `${unsubscribed.length} account(s) not subscribed to comment webhooks`,
        remedy: `Reconnect ${unsubscribed
          .map((account) => `@${account.username}`)
          .join(", ")} so the comment subscription is created.`,
      };
    }

    if (expiring.length > 0) {
      return {
        id: "instagram",
        label: "Connected Instagram accounts",
        status: "warn",
        detail: `${expiring.length} access token(s) expire within a week`,
        remedy:
          "The daily refresh cron normally handles this. If it is not running, reconnect the account.",
      };
    }

    return {
      id: "instagram",
      label: "Connected Instagram accounts",
      status: "ok",
      detail: accounts.map((account) => `@${account.username}`).join(", "),
    };
  });
}

// ─── Aggregate ──────────────────────────────────────────────────────────────

export interface SetupReadiness {
  checks: SetupCheck[];
  status: CheckStatus;
  /** Ready means comments can actually turn into DMs right now. */
  ready: boolean;
  blockers: SetupCheck[];
}

const CRITICAL_CHECK_IDS = new Set([
  "env",
  "database",
  "migrations",
  "redis",
  "worker",
]);

export async function runReadinessChecks(
  envValues: Record<string, string>,
  origin: string
): Promise<SetupReadiness> {
  const checks = [
    checkEnvironment(envValues),
    ...(await Promise.all([
      checkDatabase(),
      checkMigrations(),
      checkRedis(),
      checkQueue(),
      checkWorker(),
      checkResend(),
      checkPublicReachability(),
      checkWebhookVerification(origin),
      checkInstagramAccounts(),
    ])),
  ];

  const blockers = checks.filter(
    (check) => check.status === "error" && CRITICAL_CHECK_IDS.has(check.id)
  );
  const hasError = checks.some((check) => check.status === "error");
  const hasWarning = checks.some((check) => check.status === "warn");

  return {
    checks,
    status: hasError ? "error" : hasWarning ? "warn" : "ok",
    ready: blockers.length === 0,
    blockers,
  };
}
