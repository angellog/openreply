/**
 * Authenticating a machine client of the service API (/api/service/v1).
 *
 * The caller is KickShot Studio on Angelo's Mac, creating and attaching the
 * comment-to-DM campaigns for the reels it publishes. It holds one bearer
 * token; this deployment holds only that token's SHA-256, so a leaked env dump
 * or database backup does not leak a working credential.
 *
 *   OPENREPLY_SERVICE_TOKEN_SHA256   hex sha256 of the token (64 chars)
 *   OPENREPLY_SERVICE_WORKSPACE_ID   the one workspace the token may act in
 *
 * Deliberately separate from the dashboard's auth:
 * - These routes never read the session cookie. A logged-in browser gets 401
 *   here, so a cross-site request riding on someone's session can do nothing.
 * - The dashboard never reads the bearer token. Its routes resolve the
 *   workspace from the NextAuth session alone (lib/auth.ts), so the token is
 *   worthless there. __tests__/service-api.test.ts holds both lines.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { getRequestIp } from "@/lib/tracking/server";
import { checkServiceRateLimit } from "@/lib/service/rate-limit";

const SHA256_HEX = /^[a-f0-9]{64}$/;

export interface ServiceConfig {
  tokenHash: Buffer;
  workspaceId: string;
}

/** The service API's configuration, or null when it is switched off. */
export function readServiceConfig(): ServiceConfig | null {
  const hash = process.env.OPENREPLY_SERVICE_TOKEN_SHA256?.trim().toLowerCase();
  const workspaceId = process.env.OPENREPLY_SERVICE_WORKSPACE_ID?.trim();
  if (!hash || !workspaceId || !SHA256_HEX.test(hash)) return null;
  return { tokenHash: Buffer.from(hash, "hex"), workspaceId };
}

export function hashServiceToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Constant-time: the comparison takes as long for a near miss as a far one. */
export function serviceTokenMatches(token: string, expectedHash: Buffer): boolean {
  const actual = createHash("sha256").update(token, "utf8").digest();
  return actual.length === expectedHash.length && timingSafeEqual(actual, expectedHash);
}

export function serviceError(
  status: number,
  error: string,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {}
) {
  return NextResponse.json(
    { error, ...extra },
    { status, headers: { "Cache-Control": "no-store", ...headers } }
  );
}

export type ServiceAuthResult =
  | { ok: true; workspaceId: string }
  | { ok: false; response: NextResponse };

export async function authenticateServiceRequest(
  request: Request
): Promise<ServiceAuthResult> {
  const config = readServiceConfig();
  if (!config) {
    return { ok: false, response: serviceError(503, "service API not configured") };
  }

  const rate = await checkServiceRateLimit(getRequestIp(request));
  if (!rate.allowed) {
    return {
      ok: false,
      response: serviceError(
        429,
        "rate limited",
        { retryAfterSeconds: rate.retryAfterSeconds },
        {
          "Retry-After": String(rate.retryAfterSeconds),
          "X-RateLimit-Limit": String(rate.limit),
          "X-RateLimit-Remaining": "0",
        }
      ),
    };
  }

  // Only the Authorization header counts. Cookies are never consulted.
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  if (!match) {
    return {
      ok: false,
      response: serviceError(401, "missing bearer token", {}, {
        "WWW-Authenticate": 'Bearer realm="openreply-service"',
      }),
    };
  }

  if (!serviceTokenMatches(match[1], config.tokenHash)) {
    return {
      ok: false,
      response: serviceError(401, "invalid token", {}, {
        "WWW-Authenticate": 'Bearer realm="openreply-service", error="invalid_token"',
      }),
    };
  }

  // A token pointed at a workspace that does not exist is a configuration
  // mistake, not a caller mistake, so it reads as "not configured".
  const workspace = await prisma.workspace.findUnique({
    where: { id: config.workspaceId },
    select: { id: true },
  });
  if (!workspace) {
    return {
      ok: false,
      response: serviceError(503, "service API not configured", {
        detail: "OPENREPLY_SERVICE_WORKSPACE_ID does not name an existing workspace",
      }),
    };
  }

  return { ok: true, workspaceId: workspace.id };
}
