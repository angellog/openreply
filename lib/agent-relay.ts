/**
 * Agent relay
 *
 * Meta allows one webhook callback URL per app, and OpenReply owns it. When an
 * external agent (for example the autonomous persona in
 * github.com/angellog/ai-instagram-agent) also needs the account's comments
 * and DMs, OpenReply forwards each already-verified webhook body to it.
 *
 * - Opt-in: nothing happens unless AGENT_RELAY_URL and AGENT_RELAY_SECRET are set.
 * - Scoped: AGENT_RELAY_ACCOUNT_IDS limits forwarding to those Instagram
 *   accounts; entries for other accounts are stripped before sending.
 * - Signed: x-openreply-signature: t=<unix seconds>,v1=<hex hmac-sha256(secret, "<t>.<body>")>.
 *   The timestamp lets the receiver reject replays older than five minutes.
 * - Durable: a failed delivery is queued on its own BullMQ queue and retried
 *   with exponential backoff by the worker, so agent downtime loses nothing.
 */

import { createHmac } from "crypto";
import { Queue, Worker, type Job } from "bullmq";
import { getRedisConnection } from "@/lib/queue/client";

export const AGENT_RELAY_QUEUE = "agent-relay";
export const AGENT_RELAY_JOB_NAME = "relay-webhook";
const DELIVERY_TIMEOUT_MS = 4_000;

export interface AgentRelayConfig {
  url: string;
  secret: string;
  accountIds: Set<string> | null;
}

export interface AgentRelayJob {
  body: string;
}

export function getAgentRelayConfig(
  env: Record<string, string | undefined> = process.env
): AgentRelayConfig | null {
  const url = env.AGENT_RELAY_URL?.trim();
  const secret = env.AGENT_RELAY_SECRET?.trim();
  if (!url || !secret) return null;
  const ids = (env.AGENT_RELAY_ACCOUNT_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return { url, secret, accountIds: ids.length ? new Set(ids) : null };
}

export function signAgentRelay(
  body: string,
  secret: string,
  t: number = Math.floor(Date.now() / 1000)
): string {
  const v1 = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  return `t=${t},v1=${v1}`;
}

/**
 * Keep only the entries for relayed accounts. Returns the body to send, or
 * null when nothing in this delivery concerns the agent. The original body is
 * forwarded byte-for-byte when no filtering is needed.
 */
export function selectRelayBody(
  rawBody: string,
  payload: unknown,
  accountIds: Set<string> | null
): string | null {
  const p = payload as { object?: string; entry?: Array<{ id?: string }> };
  if (!p || p.object !== "instagram" || !Array.isArray(p.entry)) return null;
  if (!accountIds) return rawBody;
  const entries = p.entry.filter((e) => e.id && accountIds.has(String(e.id)));
  if (entries.length === 0) return null;
  if (entries.length === p.entry.length) return rawBody;
  return JSON.stringify({ ...p, entry: entries });
}

export async function deliverToAgent(
  body: string,
  config: AgentRelayConfig,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  const res = await fetchImpl(config.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-openreply-signature": signAgentRelay(body, config.secret),
    },
    body,
    signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Agent relay responded ${res.status}`);
  }
}

let relayQueue: Queue<AgentRelayJob> | null = null;

export function getAgentRelayQueue(): Queue<AgentRelayJob> {
  if (!relayQueue) {
    relayQueue = new Queue<AgentRelayJob>(AGENT_RELAY_QUEUE, {
      connection: getRedisConnection(),
      defaultJobOptions: {
        attempts: 10,
        // 30s, 1m, 2m, ... ~4h total: covers an agent redeploy or short outage.
        backoff: { type: "exponential", delay: 30_000 },
        removeOnComplete: { count: 500 },
        removeOnFail: { age: 7 * 24 * 3600 },
      },
    });
  }
  return relayQueue;
}

/**
 * Forward one verified webhook. Never throws: the agent is an optional
 * consumer and must not affect OpenReply's own processing.
 */
export async function relayToAgent(
  rawBody: string,
  payload: unknown,
  options: {
    config?: AgentRelayConfig | null;
    fetchImpl?: typeof fetch;
    enqueue?: (job: AgentRelayJob) => Promise<unknown>;
    onError?: (message: string) => Promise<void> | void;
  } = {}
): Promise<"disabled" | "skipped" | "delivered" | "queued" | "failed"> {
  const config = options.config === undefined ? getAgentRelayConfig() : options.config;
  if (!config) return "disabled";
  const body = selectRelayBody(rawBody, payload, config.accountIds);
  if (!body) return "skipped";
  try {
    await deliverToAgent(body, config, options.fetchImpl);
    return "delivered";
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    try {
      const enqueue =
        options.enqueue ??
        ((job: AgentRelayJob) => getAgentRelayQueue().add(AGENT_RELAY_JOB_NAME, job));
      await enqueue({ body });
      return "queued";
    } catch (queueError) {
      const q = queueError instanceof Error ? queueError.message : String(queueError);
      await options.onError?.(`Agent relay failed (${reason}) and could not be queued (${q})`);
      return "failed";
    }
  }
}

/** Retries queued deliveries. Started by the worker process when configured. */
export function createAgentRelayWorker(
  config: AgentRelayConfig | null = getAgentRelayConfig()
): Worker<AgentRelayJob> | null {
  if (!config) return null;
  return new Worker<AgentRelayJob>(
    AGENT_RELAY_QUEUE,
    async (job: Job<AgentRelayJob>) => deliverToAgent(job.data.body, config),
    { connection: getRedisConnection(), concurrency: 5 }
  );
}
