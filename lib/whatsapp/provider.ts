/**
 * WhatsApp provider
 *
 * The gateway sits behind this interface so the provider can be swapped
 * (OpenWA today, Meta's Cloud API later) without touching callers.
 */

export interface SendTextParams {
  chatId: string;
  text: string;
  /** Which connected number to send from. Falls back to OPENWA_SESSION_ID. */
  sessionId?: string;
}

export interface SendTextResult {
  providerMessageId: string | null;
}

export interface WhatsAppProvider {
  readonly name: string;
  sendText(params: SendTextParams): Promise<SendTextResult>;
}

export class WhatsAppProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = "WhatsAppProviderError";
  }
}

class OpenWaProvider implements WhatsAppProvider {
  readonly name = "openwa";

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly defaultSessionId: string | undefined
  ) {}

  async sendText({
    chatId,
    text,
    sessionId,
  }: SendTextParams): Promise<SendTextResult> {
    const session = sessionId ?? this.defaultSessionId;
    if (!session) {
      throw new WhatsAppProviderError(
        "No WhatsApp session: pass sessionId or set OPENWA_SESSION_ID"
      );
    }

    const url = `${this.baseUrl.replace(/\/$/, "")}/api/sessions/${encodeURIComponent(
      session
    )}/messages/send-text`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": this.apiKey,
        },
        body: JSON.stringify({ chatId, text }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "unknown error";
      throw new WhatsAppProviderError(`OpenWA unreachable: ${reason}`);
    }

    if (!response.ok) {
      throw new WhatsAppProviderError(
        `OpenWA send failed: ${response.status} ${(await response.text()).slice(0, 200)}`,
        response.status
      );
    }

    const payload = (await response.json().catch(() => null)) as
      | { messageId?: string }
      | null;

    return { providerMessageId: payload?.messageId ?? null };
  }
}

/**
 * Returns null when WhatsApp is not configured. Callers still record the lead,
 * so switching the gateway on later loses no attribution.
 */
export function getWhatsAppProvider(): WhatsAppProvider | null {
  const baseUrl = process.env.OPENWA_BASE_URL;
  const apiKey = process.env.OPENWA_API_KEY;

  // OPENWA_SESSION_ID is optional: with several numbers connected, replies go
  // out through whichever session the inbound message arrived on.
  if (!baseUrl || !apiKey) return null;

  return new OpenWaProvider(baseUrl, apiKey, process.env.OPENWA_SESSION_ID);
}
