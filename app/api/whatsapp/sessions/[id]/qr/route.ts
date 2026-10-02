import { NextResponse } from "next/server";
import { getCurrentWorkspaceId } from "@/lib/auth";
import { ensureOpenReplyWebhook, openWa } from "@/lib/whatsapp/openwa";
import { WhatsAppProviderError } from "@/lib/whatsapp/provider";

type RouteProps = { params: Promise<{ id: string }> };

/**
 * Polled by the "add number" dialog. Returns the QR while it's scannable, and
 * the phone once the number is linked.
 */
export async function GET(_request: Request, { params }: RouteProps) {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  try {
    const session = await openWa.getSession(id);

    if (session.status === "ready") {
      // Heal a session whose webhook was deleted in the OpenWA dashboard.
      await ensureOpenReplyWebhook(id);
      return NextResponse.json({
        success: true,
        data: { status: session.status, phone: session.phone ?? null, qrCode: null },
      });
    }

    if (session.status === "qr_ready") {
      const qr = await openWa.getQr(id);
      return NextResponse.json({
        success: true,
        data: { status: qr.status ?? session.status, phone: null, qrCode: qr.qrCode },
      });
    }

    return NextResponse.json({
      success: true,
      data: {
        status: session.status,
        phone: session.phone ?? null,
        qrCode: null,
        lastError: session.lastError ?? null,
      },
    });
  } catch (error) {
    const message = error instanceof WhatsAppProviderError ? error.message : "Unknown error";
    return NextResponse.json({ success: false, error: message }, { status: 502 });
  }
}
