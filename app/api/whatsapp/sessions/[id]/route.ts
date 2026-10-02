import { NextResponse } from "next/server";
import { getCurrentWorkspaceId } from "@/lib/auth";
import { openWa } from "@/lib/whatsapp/openwa";
import { WhatsAppProviderError } from "@/lib/whatsapp/provider";

type RouteProps = { params: Promise<{ id: string }> };

export async function DELETE(_request: Request, { params }: RouteProps) {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  try {
    await openWa.deleteSession(id);
    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof WhatsAppProviderError ? error.message : "Unknown error";
    return NextResponse.json({ success: false, error: message }, { status: 502 });
  }
}
