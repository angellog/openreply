import { NextRequest, NextResponse } from "next/server";
import { getCurrentWorkspaceId } from "@/lib/auth";
import {
  ensureOpenReplyWebhook,
  isOpenWaConfigured,
  openWa,
  SESSION_NAME_PATTERN,
} from "@/lib/whatsapp/openwa";
import { WhatsAppProviderError } from "@/lib/whatsapp/provider";

function providerError(error: unknown) {
  const message =
    error instanceof WhatsAppProviderError
      ? error.message
      : error instanceof Error
        ? error.message
        : "Unknown error";
  return NextResponse.json({ success: false, error: message }, { status: 502 });
}

export async function GET() {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  if (!isOpenWaConfigured()) {
    return NextResponse.json({
      success: true,
      data: { configured: false, sessions: [] },
    });
  }

  try {
    const sessions = await openWa.listSessions();
    return NextResponse.json({ success: true, data: { configured: true, sessions } });
  } catch (error) {
    return providerError(error);
  }
}

/** Adds a number: create the session, start it (so a QR appears), wire its webhook. */
export async function POST(request: NextRequest) {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as { name?: string } | null;
  const name = body?.name?.trim() ?? "";
  if (!SESSION_NAME_PATTERN.test(name)) {
    return NextResponse.json(
      {
        success: false,
        error: "Name must be 3–50 letters, numbers or hyphens (e.g. feetbit)",
      },
      { status: 400 }
    );
  }

  try {
    const session = await openWa.createSession(name);
    // Webhook first: a number that connects before its webhook exists would
    // silently drop its first messages.
    await ensureOpenReplyWebhook(session.id);
    const started = await openWa.startSession(session.id);
    return NextResponse.json({ success: true, data: started ?? session });
  } catch (error) {
    return providerError(error);
  }
}
