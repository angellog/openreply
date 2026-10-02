import { NextResponse } from "next/server";
import { getCurrentWorkspaceId } from "@/lib/auth";
import { ensureOpenReplyWebhook, openWa } from "@/lib/whatsapp/openwa";
import { WhatsAppProviderError } from "@/lib/whatsapp/provider";

type RouteProps = { params: Promise<{ id: string }> };

/** Restarts a disconnected or failed number so a fresh QR can be scanned. */
export async function POST(_request: Request, { params }: RouteProps) {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  try {
    await ensureOpenReplyWebhook(id);
    const session = await openWa.startSession(id);
    return NextResponse.json({ success: true, data: session });
  } catch (error) {
    const message = error instanceof WhatsAppProviderError ? error.message : "Unknown error";
    return NextResponse.json({ success: false, error: message }, { status: 502 });
  }
}
