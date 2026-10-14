/**
 * Authenticating a Harvey agent.
 *
 * Harvey calls from the operator's own machine over the public internet, so
 * every request is signed (see ./signature.ts). The agent id travels in a
 * header, the shared secret never does.
 *
 * A failure here is interesting to the operator — a drifted clock and a wrong
 * secret both look like "Harvey stopped working" — so each one records an
 * OperationalEvent, deduped so an agent stuck in a retry loop cannot flood the
 * log.
 */

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { decryptToken } from "@/lib/meta/oauth";
import {
  HARVEY_AGENT_HEADER,
  HARVEY_SIGNATURE_HEADER,
  HARVEY_TIMESTAMP_HEADER,
  verifyHarveySignature,
  type HarveyVerifyFailure,
} from "@/lib/harvey/signature";

export type HarveyAuthCode =
  | "UNKNOWN_AGENT"
  | "AGENT_REVOKED"
  | "BAD_AGENT_SECRET"
  | HarveyVerifyFailure;

export type HarveyAuthResult =
  | { ok: false; status: 401 | 403; code: HarveyAuthCode }
  | {
      ok: true;
      agent: {
        id: string;
        workspaceId: string;
        name: string;
        whatsappPhone: string | null;
        whatsappMessage: string | null;
        defaultDestinationUrl: string | null;
      };
      rawBody: string;
    };

/** How often the same failure from the same agent is worth recording. */
const AUTH_EVENT_DEDUPE_MS = 60 * 60 * 1000;

async function recordAuthFailure(
  workspaceId: string,
  agentId: string,
  agentName: string,
  code: string
) {
  const message = `Harvey agent "${agentName}" could not authenticate (${code})`;
  const recent = await prisma.operationalEvent
    .findFirst({
      where: {
        workspaceId,
        source: "HARVEY",
        message,
        createdAt: { gt: new Date(Date.now() - AUTH_EVENT_DEDUPE_MS) },
      },
      select: { id: true },
    })
    .catch(() => null);
  if (recent) return;

  await prisma.operationalEvent
    .create({
      data: {
        workspaceId,
        source: "HARVEY",
        level: "ERROR",
        message,
        payload: { agentId, code },
      },
    })
    .catch(() => undefined);
}

/**
 * Verifies the request and returns the agent plus the raw body, which the
 * caller must use for parsing — re-reading the stream would fail, and
 * re-encoding a parsed body would no longer match what was signed.
 */
export async function authenticateHarveyRequest(
  request: NextRequest
): Promise<HarveyAuthResult> {
  const rawBody = await request.text();
  const agentId = request.headers.get(HARVEY_AGENT_HEADER);
  const signature = request.headers.get(HARVEY_SIGNATURE_HEADER);
  const timestamp = request.headers.get(HARVEY_TIMESTAMP_HEADER);

  if (!agentId) return { ok: false, status: 401, code: "UNKNOWN_AGENT" };

  const agent = await prisma.harveyAgent.findUnique({
    where: { id: agentId },
    select: {
      id: true,
      workspaceId: true,
      name: true,
      status: true,
      secretEncrypted: true,
      whatsappPhone: true,
      whatsappMessage: true,
      defaultDestinationUrl: true,
    },
  });
  // No workspace to log against, and an unknown id is as likely a probe as a
  // misconfiguration.
  if (!agent) return { ok: false, status: 401, code: "UNKNOWN_AGENT" };

  if (agent.status === "REVOKED") {
    // 403, not 401: the credentials are real, the agent is not allowed. A
    // revoked agent that keeps calling is worth seeing in the log.
    await recordAuthFailure(agent.workspaceId, agent.id, agent.name, "AGENT_REVOKED");
    return { ok: false, status: 403, code: "AGENT_REVOKED" };
  }

  let secret: string;
  try {
    secret = decryptToken(agent.secretEncrypted);
  } catch {
    // The stored secret cannot be read: ENCRYPTION_KEY was rotated without
    // re-pairing the agent. Retrying will never fix it, so name the cause.
    await recordAuthFailure(agent.workspaceId, agent.id, agent.name, "BAD_AGENT_SECRET");
    return { ok: false, status: 401, code: "BAD_AGENT_SECRET" };
  }

  const verified = verifyHarveySignature({ rawBody, signature, timestamp, secret });
  if (!verified.ok) {
    await recordAuthFailure(agent.workspaceId, agent.id, agent.name, verified.reason);
    return { ok: false, status: 401, code: verified.reason };
  }

  await prisma.harveyAgent
    .update({ where: { id: agent.id }, data: { lastSeenAt: new Date() } })
    .catch(() => undefined);

  return {
    ok: true,
    agent: {
      id: agent.id,
      workspaceId: agent.workspaceId,
      name: agent.name,
      whatsappPhone: agent.whatsappPhone,
      whatsappMessage: agent.whatsappMessage,
      defaultDestinationUrl: agent.defaultDestinationUrl,
    },
    rawBody,
  };
}
