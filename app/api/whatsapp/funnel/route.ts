import { NextResponse } from "next/server";
import { getCurrentWorkspaceId } from "@/lib/auth";
import { prisma } from "@/lib/db/client";

/**
 * Per-campaign path from Instagram to WhatsApp: DMs sent → link clicks →
 * WhatsApp chats started. Only campaigns with at least one of those appear.
 */
export async function GET() {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const [automations, dms, clicks, leads] = await Promise.all([
    prisma.automation.findMany({
      where: { workspaceId },
      select: { id: true, name: true, instagramAccount: { select: { username: true } } },
    }),
    prisma.dmLog.groupBy({
      by: ["automationId"],
      where: { workspaceId, status: "SENT" },
      _count: { _all: true },
    }),
    prisma.linkClick.groupBy({
      by: ["automationId"],
      where: { workspaceId },
      _count: { _all: true },
    }),
    prisma.whatsAppLead.groupBy({
      by: ["automationId"],
      where: { workspaceId, automationId: { not: null } },
      _count: { _all: true },
    }),
  ]);

  const count = (rows: { automationId: string | null; _count: { _all: number } }[]) =>
    new Map(rows.map((r) => [r.automationId, r._count._all]));
  const dmMap = count(dms);
  const clickMap = count(clicks);
  const leadMap = count(leads);

  const funnel = automations
    .map((a) => ({
      automationId: a.id,
      name: a.name,
      account: a.instagramAccount?.username ?? null,
      dmsSent: dmMap.get(a.id) ?? 0,
      clicks: clickMap.get(a.id) ?? 0,
      whatsappLeads: leadMap.get(a.id) ?? 0,
    }))
    .filter((row) => row.dmsSent + row.clicks + row.whatsappLeads > 0)
    .sort((a, b) => b.dmsSent - a.dmsSent);

  return NextResponse.json({ success: true, data: { funnel } });
}
