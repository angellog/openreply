import { NextResponse, type NextRequest } from "next/server";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { encryptToken } from "@/lib/meta/oauth";
import {
  canManageWorkspace,
  getCurrentWorkspaceContext,
} from "@/lib/workspace-access";
import { normalizeWhatsAppPhone } from "@/lib/whatsapp/ref";

/**
 * Pairing and configuring the operator's Harvey agents — one per brand.
 *
 * Pairing is one-directional on purpose: this app hands out an id and a
 * secret, the operator pastes them into that brand's Harvey .env, and from
 * then on Harvey does all the calling. Nothing here ever needs to reach the
 * operator's machine, so there is no address to configure and no port to
 * forward.
 *
 * The secret is shown exactly once. It is stored encrypted (AES-256-GCM, the
 * same ENCRYPTION_KEY that protects Instagram tokens) because verifying an
 * HMAC needs the plaintext back — a one-way hash would not work here.
 */

/** Treat an agent that has not called in this long as offline. Harvey's
 *  default heartbeat is 15 minutes, so this is four missed beats: long enough
 *  to ride out a flaky connection, short enough to notice a closed laptop. */
const OFFLINE_AFTER_MS = 60 * 60 * 1000;

/** Lower-case, dashes and digits. These names appear in URLs and in Harvey's
 *  own config, so they stay boring on purpose. */
const AGENT_NAME = /^[a-z0-9][a-z0-9-]{1,39}$/;

export async function GET() {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const agents = await prisma.harveyAgent.findMany({
    where: { workspaceId: context.workspaceId },
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      status: true,
      secretPrefix: true,
      whatsappPhone: true,
      whatsappMessage: true,
      whatsappGreeting: true,
      defaultDestinationUrl: true,
      lastSeenAt: true,
      lastSyncAt: true,
      agentVersion: true,
      brainProvider: true,
      createdAt: true,
      _count: { select: { prospects: true, emails: true } },
    },
  });

  const now = Date.now();
  return NextResponse.json({
    success: true,
    data: {
      agents: agents.map((agent) => ({
        ...agent,
        online:
          agent.lastSeenAt !== null &&
          now - agent.lastSeenAt.getTime() < OFFLINE_AFTER_MS,
      })),
      offlineAfterSeconds: OFFLINE_AFTER_MS / 1000,
    },
  });
}

const createSchema = z.object({
  name: z
    .string()
    .regex(AGENT_NAME, "lower-case letters, digits and dashes, 2-40 characters"),
});

/**
 * Creates an agent, or rotates the secret of the one with that name. Rotation
 * is the recovery path for a leaked secret and for a rotated ENCRYPTION_KEY,
 * and it stops the old secret working immediately.
 */
export async function POST(request: NextRequest) {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  if (!canManageWorkspace(context.role)) {
    return NextResponse.json(
      { success: false, error: "Only an admin can pair an outbound agent" },
      { status: 403 }
    );
  }

  const parsed = createSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: "Invalid request", issues: parsed.error.issues.slice(0, 5) },
      { status: 422 }
    );
  }

  const secret = randomBytes(32).toString("base64url");
  const shared = {
    secretEncrypted: encryptToken(secret),
    secretPrefix: secret.slice(0, 6),
    // Rotating a revoked agent's secret brings it back; that is the only way
    // to undo a revocation, and it necessarily issues a new secret.
    status: "ACTIVE" as const,
  };

  const agent = await prisma.harveyAgent.upsert({
    where: { workspaceId_name: { workspaceId: context.workspaceId, name: parsed.data.name } },
    create: { workspaceId: context.workspaceId, name: parsed.data.name, ...shared },
    update: shared,
    select: { id: true, name: true, secretPrefix: true, createdAt: true },
  });

  await prisma.operationalEvent
    .create({
      data: {
        workspaceId: context.workspaceId,
        source: "HARVEY",
        level: "INFO",
        message: `Outbound agent secret issued for "${agent.name}"`,
        payload: { agentId: agent.id, issuedBy: context.userId },
      },
    })
    .catch(() => undefined);

  return NextResponse.json({
    success: true,
    data: {
      agent,
      // Shown once. Not retrievable afterwards; rotate to get a new one.
      secret,
      env: {
        OPENREPLY_AGENT_ID: agent.id,
        OPENREPLY_AGENT_SECRET: secret,
      },
    },
  });
}

const updateSchema = z.object({
  agentId: z.string().min(1).max(64),
  status: z.enum(["ACTIVE", "REVOKED"]).optional(),
  /// Null clears a destination. Undefined leaves it alone.
  whatsappPhone: z.string().max(20).nullish(),
  whatsappMessage: z.string().max(300).nullish(),
  whatsappGreeting: z.string().max(1000).nullish(),
  defaultDestinationUrl: z.string().url().max(2000).nullish(),
});

/**
 * Sets where this agent's links send people, and revokes or restores it.
 *
 * Destinations live on the agent rather than in each mint request so a
 * compromised agent cannot point a link on this domain at a number or a site
 * the operator never chose.
 */
export async function PATCH(request: NextRequest) {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  if (!canManageWorkspace(context.role)) {
    return NextResponse.json(
      { success: false, error: "Only an admin can change an outbound agent" },
      { status: 403 }
    );
  }

  const parsed = updateSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: "Invalid request", issues: parsed.error.issues.slice(0, 5) },
      { status: 422 }
    );
  }

  const { agentId, ...changes } = parsed.data;
  const existing = await prisma.harveyAgent.findFirst({
    where: { id: agentId, workspaceId: context.workspaceId },
    select: { id: true, name: true },
  });
  if (!existing) {
    return NextResponse.json({ success: false, error: "Agent not found" }, { status: 404 });
  }

  const agent = await prisma.harveyAgent.update({
    where: { id: existing.id },
    data: {
      ...(changes.status !== undefined ? { status: changes.status } : {}),
      ...(changes.whatsappPhone !== undefined
        ? {
            whatsappPhone: changes.whatsappPhone
              ? normalizeWhatsAppPhone(changes.whatsappPhone)
              : null,
          }
        : {}),
      ...(changes.whatsappMessage !== undefined
        ? { whatsappMessage: changes.whatsappMessage }
        : {}),
      ...(changes.whatsappGreeting !== undefined
        ? { whatsappGreeting: changes.whatsappGreeting }
        : {}),
      ...(changes.defaultDestinationUrl !== undefined
        ? { defaultDestinationUrl: changes.defaultDestinationUrl }
        : {}),
    },
    select: {
      id: true,
      name: true,
      status: true,
      whatsappPhone: true,
      whatsappMessage: true,
      whatsappGreeting: true,
      defaultDestinationUrl: true,
    },
  });

  if (changes.status) {
    await prisma.operationalEvent
      .create({
        data: {
          workspaceId: context.workspaceId,
          source: "HARVEY",
          level: changes.status === "REVOKED" ? "WARNING" : "INFO",
          message: `Outbound agent "${agent.name}" ${
            changes.status === "REVOKED" ? "revoked" : "restored"
          }`,
          payload: { agentId: agent.id, by: context.userId },
        },
      })
      .catch(() => undefined);
  }

  return NextResponse.json({ success: true, data: { agent } });
}
