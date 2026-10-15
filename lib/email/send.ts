/**
 * Sending one plain email.
 *
 * The transport is whichever one magic links already use, chosen the same way
 * (lib/auth.ts): your own SMTP server when EMAIL_SERVER is set, Resend
 * otherwise. One mail path, so a deployment that can sign people in can also
 * deliver a resource.
 */

import { createTransport } from "nodemailer";

export type SendResult = { ok: true } | { ok: false; error: string };

function from(): string {
  return process.env.EMAIL_FROM ?? "OpenReply <login@example.com>";
}

/** Whether mail can be sent at all, without trying. */
export function isEmailConfigured(): boolean {
  return Boolean(process.env.EMAIL_SERVER || process.env.RESEND_API_KEY);
}

async function sendViaResend(
  to: string,
  subject: string,
  text: string,
  html: string
): Promise<SendResult> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { ok: false, error: "RESEND_API_KEY is not set" };

  let response: Response;
  try {
    response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from: from(), to: [to], subject, text, html }),
    });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "network error" };
  }

  if (!response.ok) {
    // Resend's body says which field it objected to, which is the difference
    // between "your domain is not verified" and "that address is malformed".
    const detail = await response.text().catch(() => "");
    return { ok: false, error: `Resend ${response.status}: ${detail.slice(0, 200)}` };
  }
  return { ok: true };
}

async function sendViaSmtp(
  to: string,
  subject: string,
  text: string,
  html: string
): Promise<SendResult> {
  try {
    const transport = createTransport(process.env.EMAIL_SERVER as string);
    await transport.sendMail({ to, from: from(), subject, text, html });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "smtp error" };
  }
}

/**
 * Never throws. A failed send is a recorded outcome, not an exception: the
 * visitor has already been shown their link, so a mail problem must not turn
 * into an error on their screen.
 */
export async function sendEmail({
  to,
  subject,
  text,
  html,
}: {
  to: string;
  subject: string;
  text: string;
  html: string;
}): Promise<SendResult> {
  if (!isEmailConfigured()) {
    return { ok: false, error: "No mail transport configured" };
  }
  return process.env.EMAIL_SERVER
    ? sendViaSmtp(to, subject, text, html)
    : sendViaResend(to, subject, text, html);
}
