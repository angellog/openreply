import { NextRequest, NextResponse } from "next/server";
import { getCurrentWorkspaceId } from "@/lib/auth";
import { prisma } from "@/lib/db/client";

export async function GET(request: NextRequest) {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const searchParams = request.nextUrl.searchParams;
  const page = Math.max(1, Number.parseInt(searchParams.get("page") ?? "1", 10));
  const limit = Math.min(
    50,
    Math.max(1, Number.parseInt(searchParams.get("limit") ?? "20", 10))
  );
  const instagramAccountId = searchParams.get("instagramAccountId");
  const skip = (page - 1) * limit;

  const where = {
    workspaceId,
    ...(instagramAccountId && instagramAccountId !== "all"
      ? { instagramAccountId }
      : {}),
  };

  const [leads, total] = await Promise.all([
    prisma.whatsAppLead.findMany({
      where,
      orderBy: { lastInboundAt: "desc" },
      skip,
      take: limit,
      include: {
        automation: { select: { name: true } },
        instagramAccount: { select: { username: true } },
        messages: {
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { body: true, direction: true, createdAt: true },
        },
        _count: { select: { messages: true } },
      },
    }),
    prisma.whatsAppLead.count({ where }),
  ]);

  return NextResponse.json({
    success: true,
    data: {
      leads,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    },
  });
}
