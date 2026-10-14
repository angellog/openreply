import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getCurrentWorkspaceContext } from "@/lib/workspace-access";
import { COMMAND_TTL_MS, isEmailStale } from "@/lib/harvey/sync";
import { buildTrackedUrl } from "@/lib/tracking/message";

/**
 * The operator's view of Harvey's outbox, and the decisions they make on it.
 *
 * Harvey writes cold emails but does not send them: each one waits here until
 * someone says yes. That approval happens from a phone, which is the point —
 * the alternative is Harvey's own dashboard on localhost, reachable only from
 * the machine it runs on.
 *
 * A decision does not reach Harvey directly. It becomes a queued command that
 * Harvey collects on its next heartbeat, because the machine Harvey runs on is
 * asleep most of the time.
 */

export async function GET(request: NextRequest) {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const status = request.nextUrl.searchParams.get("status");
  const now = new Date();

  const emails = await prisma.harveyEmail.findMany({
    where: {
      workspaceId: context.workspaceId,
      ...(status === "pending" ? { status: "PENDING_REVIEW" } : {}),
    },
    // Postgres orders an enum by its declared order, and HarveyEmailStatus
    // declares PENDING_REVIEW first. That is load-bearing, not luck: it keeps
    // what needs a decision at the top of the 100 even once hundreds have
    // been sent. Reordering that enum would quietly bury the approvals.
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    take: 100,
    select: {
      id: true,
      harveyId: true,
      agentId: true,
      subject: true,
      body: true,
      toEmail: true,
      step: true,
      kind: true,
      status: true,
      sendAt: true,
      sentAt: true,
      error: true,
      createdAt: true,
      trackedLink: { select: { slug: true } },
      prospect: {
        select: {
          firstName: true,
          lastName: true,
          title: true,
          score: true,
          emailStatus: true,
          personalizationNotes: true,
          company: { select: { name: true, domain: true, location: true } },
        },
      },
    },
  });

  // A decision already in flight must not offer the buttons again.
  const inFlight = await prisma.harveyCommand.findMany({
    where: {
      workspaceId: context.workspaceId,
      ackedAt: null,
      expiresAt: { gt: now },
      kind: { in: ["APPROVE_EMAIL", "REJECT_EMAIL"] },
    },
    select: {
      kind: true,
      agentId: true,
      targetHarveyId: true,
      createdAt: true,
      deliveredAt: true,
    },
  });
  // Keyed by agent as well as by Harvey's id. Harvey's ids are only unique
  // within one instance (uuid4 truncated to 12 hex chars), and a workspace
  // runs one agent per brand — so keying on the id alone would let one
  // brand's decision surface on another brand's email.
  const decisionKey = (agentId: string, harveyId: string) => `${agentId}:${harveyId}`;
  const pendingByEmail = new Map(
    inFlight
      .filter((command) => command.targetHarveyId)
      .map((command) => [
        decisionKey(command.agentId, command.targetHarveyId as string),
        command,
      ])
  );

  return NextResponse.json({
    success: true,
    data: {
      emails: emails.map((email) => {
        const pending = pendingByEmail.get(decisionKey(email.agentId, email.harveyId));
        return {
          ...email,
          stale: isEmailStale(email.status, email.createdAt, now),
          trackedUrl: email.trackedLink ? buildTrackedUrl(email.trackedLink.slug) : null,
          pendingDecision: pending
            ? {
                kind: pending.kind,
                issuedAt: pending.createdAt,
                // Null means Harvey has not been awake to collect it yet.
                deliveredAt: pending.deliveredAt,
              }
            : null,
        };
      }),
    },
  });
}

const decisionSchema = z.object({
  emailId: z.string().min(1).max(64),
  decision: z.enum(["APPROVE", "REJECT"]),
});

export async function POST(request: NextRequest) {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const parsed = decisionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: "Invalid request", issues: parsed.error.issues.slice(0, 5) },
      { status: 422 }
    );
  }

  const email = await prisma.harveyEmail.findFirst({
    where: { id: parsed.data.emailId, workspaceId: context.workspaceId },
    select: { id: true, harveyId: true, agentId: true, status: true, toEmail: true },
  });
  if (!email) {
    return NextResponse.json({ success: false, error: "Email not found" }, { status: 404 });
  }
  if (email.status !== "PENDING_REVIEW") {
    // Harvey has already moved on. Deciding again would queue a command that
    // can only no-op, and would tell the operator something untrue.
    return NextResponse.json(
      {
        success: false,
        error: `This email is already ${email.status.toLowerCase().replace("_", " ")}`,
        code: "NOT_PENDING",
      },
      { status: 409 }
    );
  }

  const kind = parsed.data.decision === "APPROVE" ? "APPROVE_EMAIL" : "REJECT_EMAIL";

  // One decision per email at a time. Tapping twice on a slow connection must
  // not queue two commands.
  //
  // This is a find-then-create, so two truly simultaneous taps can both get
  // past it. That is left alone deliberately rather than closed with a
  // serializable transaction or a partial unique index: the thing on the far
  // end is idempotent by construction. Harvey's approve_outbox only moves a
  // row that is still pending_review, so the second command reports
  // "already_approved" and nothing is sent twice. The cost of the race is a
  // spare row in a queue; the cost of the fix would be retry handling on the
  // one request the operator cares about.
  const existing = await prisma.harveyCommand.findFirst({
    where: {
      agentId: email.agentId,
      targetHarveyId: email.harveyId,
      ackedAt: null,
      expiresAt: { gt: new Date() },
      kind: { in: ["APPROVE_EMAIL", "REJECT_EMAIL"] },
    },
    select: { id: true, kind: true },
  });
  if (existing) {
    return NextResponse.json({
      success: true,
      data: { commandId: existing.id, kind: existing.kind, reused: true },
    });
  }

  const command = await prisma.harveyCommand.create({
    data: {
      workspaceId: context.workspaceId,
      agentId: email.agentId,
      kind,
      targetHarveyId: email.harveyId,
      issuedByUserId: context.userId,
      expiresAt: new Date(Date.now() + COMMAND_TTL_MS),
    },
    select: { id: true, kind: true, expiresAt: true },
  });

  return NextResponse.json({
    success: true,
    data: { commandId: command.id, kind: command.kind, expiresAt: command.expiresAt, reused: false },
  });
}
