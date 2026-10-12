import { NextResponse } from "next/server";
import { getCurrentWorkspaceId } from "@/lib/auth";
import { prisma } from "@/lib/db/client";
import { getDMQueue } from "@/lib/queue/client";
import { getWorkerAlerts, getWorkerHealth } from "@/lib/ops/worker-health";

export const runtime = "nodejs";

export async function GET() {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const [
    queueCounts,
    workerHealth,
    workerAlerts,
    webhookFailures,
    dmFailures,
    tokenRefreshFailures,
    operationalEvents,
  ] = await Promise.all([
    getDMQueue().getJobCounts("waiting", "active", "delayed", "failed"),
    getWorkerHealth(),
    getWorkerAlerts(10),
    prisma.webhookEvent.findMany({
      where: { workspaceId, status: "FAILED" },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: {
        id: true,
        object: true,
        errorMessage: true,
        createdAt: true,
        processedAt: true,
      },
    }),
    prisma.dmLog.findMany({
      where: {
        workspaceId,
        status: {
          in: [
            "FAILED",
            "SKIPPED_RATE_LIMIT",
            "SKIPPED_PLAN_LIMIT",
            "SKIPPED_NO_MATCH",
          ],
        },
      },
      orderBy: { updatedAt: "desc" },
      take: 10,
      select: {
        id: true,
        status: true,
        commentId: true,
        commentText: true,
        errorMessage: true,
        updatedAt: true,
        automation: { select: { name: true } },
      },
    }),
    prisma.operationalEvent.findMany({
      where: { workspaceId, source: "TOKEN_REFRESH", level: "ERROR" },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: {
        id: true,
        message: true,
        createdAt: true,
        payload: true,
      },
    }),
    prisma.operationalEvent.findMany({
      where: {
        OR: [{ workspaceId }, { workspaceId: null }],
      },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: {
        id: true,
        source: true,
        level: true,
        message: true,
        createdAt: true,
        resolvedAt: true,
      },
    }),
  ]);

  // An account whose Meta session died stops sending DMs silently: its token
  // still looks valid by date, and the daily refresh only runs near expiry.
  // The sweep and the overview route raise a named ERROR when Meta rejects it;
  // an account counts as healthy again once it is reconnected after that.
  const expiredEvents = await prisma.operationalEvent.findMany({
    where: {
      workspaceId,
      level: "ERROR",
      message: { startsWith: "Instagram session expired for @" },
      createdAt: { gt: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000) },
    },
    orderBy: { createdAt: "desc" },
    select: { message: true, createdAt: true, payload: true },
  });

  const accounts = await prisma.instagramAccount.findMany({
    where: { workspaceId },
    select: { username: true, connectedAt: true },
  });
  const connectedAt = new Map(accounts.map((a) => [a.username, a.connectedAt]));

  const seen = new Set<string>();
  const accountsNeedingReconnect: Array<{
    username: string;
    failedAt: Date;
  }> = [];
  for (const event of expiredEvents) {
    const username =
      (event.payload as { username?: string } | null)?.username ??
      event.message.split("@")[1]?.split(" ")[0] ??
      "";
    if (!username || seen.has(username)) continue;
    seen.add(username);
    const reconnected = connectedAt.get(username);
    if (reconnected && reconnected > event.createdAt) continue;
    accountsNeedingReconnect.push({ username, failedAt: event.createdAt });
  }

  return NextResponse.json({
    success: true,
    data: {
      accountsNeedingReconnect,
      queueCounts,
      workerHealth,
      workerAlerts,
      webhookFailures,
      dmFailures,
      tokenRefreshFailures,
      operationalEvents,
    },
  });
}
