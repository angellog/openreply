import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { authenticateHarveyRequest } from "@/lib/harvey/auth";
import {
  COMMAND_TTL_MS,
  EMAIL_STATUS_TO_DB,
  harveySyncRequest,
} from "@/lib/harvey/sync";

/**
 * The one endpoint Harvey's heartbeat calls.
 *
 * Push, ack, collect — in that order, deliberately. Harvey's work is recorded
 * and its previous orders are closed out before new ones are handed over, so a
 * command can never be delivered twice in the same breath as its own ack.
 *
 * Harvey keeps its own SQLite as the source of truth, so a 500 here is not
 * data loss: the next heartbeat re-sends the same rows under the same ids.
 */
export async function POST(request: NextRequest) {
  const auth = await authenticateHarveyRequest(request);
  if (!auth.ok) {
    return NextResponse.json(
      { success: false, error: "Unauthorized", code: auth.code },
      { status: auth.status }
    );
  }

  const { agent, rawBody } = auth;

  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return NextResponse.json(
      { success: false, error: "Body is not JSON" },
      { status: 400 }
    );
  }

  const parsed = harveySyncRequest.safeParse(json);
  if (!parsed.success) {
    // Harvey would retry the same malformed body forever, so tell it exactly
    // which field is wrong rather than just refusing.
    return NextResponse.json(
      {
        success: false,
        error: "Invalid sync payload",
        issues: parsed.error.issues.slice(0, 10),
      },
      { status: 422 }
    );
  }

  const { runtime, acks, companies, prospects, emails } = parsed.data;
  const workspaceId = agent.workspaceId;

  // ── 1. Record what Harvey learned ────────────────────────────────────────
  const companyWrites = (companies ?? []).map((company) => {
    const data = {
      name: company.name,
      domain: company.domain ?? null,
      website: company.website ?? null,
      industry: company.industry ?? null,
      location: company.location ?? null,
      sourceUrl: company.sourceUrl ?? null,
    };
    return prisma.harveyCompany.upsert({
      where: { agentId_harveyId: { agentId: agent.id, harveyId: company.harveyId } },
      create: { workspaceId, agentId: agent.id, harveyId: company.harveyId, ...data },
      update: data,
    });
  });
  if (companyWrites.length) await prisma.$transaction(companyWrites);

  // Harvey references its own company ids; map them to local rows once.
  const companyIdByHarveyId = new Map<string, string>();
  const referencedCompanyIds = [
    ...new Set((prospects ?? []).map((p) => p.companyHarveyId).filter(Boolean)),
  ] as string[];
  if (referencedCompanyIds.length > 0) {
    const rows = await prisma.harveyCompany.findMany({
      where: { agentId: agent.id, harveyId: { in: referencedCompanyIds } },
      select: { id: true, harveyId: true },
    });
    for (const row of rows) companyIdByHarveyId.set(row.harveyId, row.id);
  }

  const prospectWrites = (prospects ?? []).map((prospect) => {
    const data = {
      companyId: prospect.companyHarveyId
        ? companyIdByHarveyId.get(prospect.companyHarveyId) ?? null
        : null,
      firstName: prospect.firstName ?? null,
      lastName: prospect.lastName ?? null,
      email: prospect.email,
      emailStatus: prospect.emailStatus ?? null,
      title: prospect.title ?? null,
      status: prospect.status ?? null,
      score: prospect.score ?? null,
      personalizationNotes: prospect.personalizationNotes ?? null,
    };
    return prisma.harveyProspect.upsert({
      where: { agentId_harveyId: { agentId: agent.id, harveyId: prospect.harveyId } },
      create: { workspaceId, agentId: agent.id, harveyId: prospect.harveyId, ...data },
      update: data,
    });
  });
  if (prospectWrites.length) await prisma.$transaction(prospectWrites);

  const prospectIdByHarveyId = new Map<string, string>();
  const referencedProspectIds = [
    ...new Set((emails ?? []).map((e) => e.prospectHarveyId).filter(Boolean)),
  ] as string[];
  if (referencedProspectIds.length > 0) {
    const rows = await prisma.harveyProspect.findMany({
      where: { agentId: agent.id, harveyId: { in: referencedProspectIds } },
      select: { id: true, harveyId: true },
    });
    for (const row of rows) prospectIdByHarveyId.set(row.harveyId, row.id);
  }

  const emailWrites = (emails ?? []).map((email) => {
    const data = {
      prospectId: email.prospectHarveyId
        ? prospectIdByHarveyId.get(email.prospectHarveyId) ?? null
        : null,
      campaignHarveyId: email.campaignHarveyId ?? null,
      step: email.step,
      kind: email.kind,
      toEmail: email.toEmail,
      subject: email.subject,
      body: email.body,
      status: EMAIL_STATUS_TO_DB[email.status],
      sendAt: email.sendAt ? new Date(email.sendAt) : null,
      sentAt: email.sentAt ? new Date(email.sentAt) : null,
      error: email.error ?? null,
    };
    return prisma.harveyEmail.upsert({
      where: { agentId_harveyId: { agentId: agent.id, harveyId: email.harveyId } },
      create: { workspaceId, agentId: agent.id, harveyId: email.harveyId, ...data },
      update: data,
    });
  });

  // ── 2. Close out the commands Harvey already applied ─────────────────────
  //
  // Scoped to this agent, so one workspace's Harvey cannot ack another's, and
  // already-acked commands are left alone — the first ack wins.
  const ackedAt = new Date();
  const ackWrites = (acks ?? []).map((ack) =>
    prisma.harveyCommand.updateMany({
      where: { id: ack.commandId, agentId: agent.id, ackedAt: null },
      data: { ackedAt, result: ack.result },
    })
  );

  // Emails and acks share a batch: neither depends on the other, so there is
  // no reason to pay for two round trips.
  const writeResults =
    emailWrites.length + ackWrites.length > 0
      ? await prisma.$transaction([...emailWrites, ...ackWrites])
      : [];
  const acked = writeResults
    .slice(emailWrites.length)
    .reduce(
      (total, result) => total + ((result as { count?: number }).count ?? 0),
      0
    );

  // ── 3. Hand over what the operator decided ───────────────────────────────
  const now = new Date();
  const pending = await prisma.harveyCommand.findMany({
    where: { agentId: agent.id, ackedAt: null, expiresAt: { gt: now } },
    orderBy: { createdAt: "asc" },
    take: 100,
    select: {
      id: true,
      kind: true,
      targetHarveyId: true,
      payload: true,
      createdAt: true,
      expiresAt: true,
    },
  });

  if (pending.length > 0) {
    // First delivery only: deliveredAt answers "did Harvey ever see this?",
    // which a redelivery would overwrite.
    await prisma.harveyCommand.updateMany({
      where: { id: { in: pending.map((c) => c.id) }, deliveredAt: null },
      data: { deliveredAt: now },
    });
  }

  await prisma.harveyAgent.update({
    where: { id: agent.id },
    data: {
      lastSyncAt: now,
      ...(runtime?.version ? { agentVersion: runtime.version } : {}),
      ...(runtime?.brainProvider ? { brainProvider: runtime.brainProvider } : {}),
    },
  });

  return NextResponse.json({
    success: true,
    data: {
      counts: {
        companies: companies?.length ?? 0,
        prospects: prospects?.length ?? 0,
        emails: emails?.length ?? 0,
        acked,
      },
      commands: pending.map((command) => ({
        id: command.id,
        kind: command.kind,
        targetHarveyId: command.targetHarveyId,
        payload: command.payload,
        expiresAt: command.expiresAt.toISOString(),
      })),
      serverTime: now.toISOString(),
      commandTtlSeconds: COMMAND_TTL_MS / 1000,
    },
  });
}
