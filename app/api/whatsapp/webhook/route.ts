import { NextRequest, NextResponse } from "next/server";
import {
  handleInboundWhatsAppMessage,
  type InboundWhatsAppMessage,
} from "@/lib/whatsapp/inbound";
import {
  OPENWA_SIGNATURE_HEADER,
  verifyOpenWaSignature,
} from "@/lib/whatsapp/signature";

/**
 * OpenWA webhook receiver.
 *
 * OpenWA signs the raw body as `sha256=<hex>` in `X-OpenWA-Signature`. Without
 * OPENWA_WEBHOOK_SECRET set, every request is rejected rather than trusted —
 * this endpoint can create records and send WhatsApp messages.
 */
export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const signature = request.headers.get(OPENWA_SIGNATURE_HEADER);

  if (
    !verifyOpenWaSignature(rawBody, signature, process.env.OPENWA_WEBHOOK_SECRET)
  ) {
    return NextResponse.json(
      { success: false, error: "Invalid signature" },
      { status: 401 }
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid JSON" },
      { status: 400 }
    );
  }

  const envelope = payload as {
    event?: string;
    sessionId?: string;
    data?: InboundWhatsAppMessage & {
      payload?: InboundWhatsAppMessage;
      sessionId?: string;
    };
  };

  if (envelope.event && envelope.event !== "message.received") {
    return NextResponse.json({ success: true, ignored: envelope.event });
  }

  const message = envelope.data?.payload ?? envelope.data;
  if (!message) {
    return NextResponse.json({ success: true, ignored: "no message data" });
  }

  try {
    const sessionId = envelope.sessionId ?? envelope.data?.sessionId;
    const result = await handleInboundWhatsAppMessage(message, sessionId);
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    console.error("[WhatsApp Webhook] Error:", error);
    // 500 tells OpenWA to retry; the inbound message is not lost.
    return NextResponse.json(
      { success: false, error: "Processing failed" },
      { status: 500 }
    );
  }
}
