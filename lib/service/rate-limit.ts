/**
 * Rate limit for the service API.
 *
 * A fixed one-minute window per caller IP. KickShot makes a handful of calls
 * per published reel, so the default (120 a minute) is far above honest use
 * and far below what would hurt the database. It is applied before the token
 * is checked, so guessing tokens is throttled too.
 *
 * Redis holds the counter when REDIS_URL is set, so every Vercel instance
 * shares one window. If Redis is unset, slow (>250 ms) or down, the limiter
 * falls back to a per-instance in-memory window rather than failing the
 * request or hanging on a dead connection.
 */

import { createHash } from "node:crypto";
import { getRedisConnection } from "@/lib/queue/client";

const WINDOW_SECONDS = 60;
const DEFAULT_LIMIT_PER_MINUTE = 120;
const REDIS_TIMEOUT_MS = 250;

export function getServiceRateLimitPerMinute(): number {
  const configured = Number.parseInt(
    process.env.OPENREPLY_SERVICE_RATE_LIMIT_PER_MINUTE ?? "",
    10
  );
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_LIMIT_PER_MINUTE;
}

export interface ServiceRateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Seconds until the current window resets. */
  retryAfterSeconds: number;
}

const memoryWindows = new Map<string, { count: number; resetAt: number }>();

function countInMemory(key: string, now: number): number {
  const entry = memoryWindows.get(key);
  if (!entry || entry.resetAt <= now) {
    memoryWindows.set(key, { count: 1, resetAt: now + WINDOW_SECONDS * 1000 });
    // Keep the map from growing without bound on a long-lived instance.
    if (memoryWindows.size > 10_000) {
      for (const [k, v] of memoryWindows) if (v.resetAt <= now) memoryWindows.delete(k);
    }
    return 1;
  }
  entry.count += 1;
  return entry.count;
}

async function countInRedis(key: string): Promise<number | null> {
  if (!process.env.REDIS_URL) return null;
  try {
    const redis = getRedisConnection();
    const result = await Promise.race([
      redis
        .multi()
        .incr(key)
        .expire(key, WINDOW_SECONDS + 5)
        .exec(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), REDIS_TIMEOUT_MS)),
    ]);
    const count = result?.[0]?.[1];
    return typeof count === "number" ? count : null;
  } catch {
    return null;
  }
}

/** Counts this request against the caller's window and says whether it may proceed. */
export async function checkServiceRateLimit(
  callerId: string | null
): Promise<ServiceRateLimitResult> {
  const limit = getServiceRateLimitPerMinute();
  const now = Date.now();
  const windowStart = Math.floor(now / (WINDOW_SECONDS * 1000));
  const caller = createHash("sha256")
    .update(callerId ?? "unknown")
    .digest("hex")
    .slice(0, 32);
  const key = `rate:service:${caller}:${windowStart}`;

  const count = (await countInRedis(key)) ?? countInMemory(key, now);
  const retryAfterSeconds = Math.max(
    1,
    Math.ceil(((windowStart + 1) * WINDOW_SECONDS * 1000 - now) / 1000)
  );

  return {
    allowed: count <= limit,
    limit,
    remaining: Math.max(0, limit - count),
    retryAfterSeconds,
  };
}

/** Test hook: forget every in-memory window. */
export function resetServiceRateLimitMemory(): void {
  memoryWindows.clear();
}
