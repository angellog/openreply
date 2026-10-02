/**
 * OpenWA admin client
 *
 * Session management for the self-hosted gateway: list the connected numbers,
 * add one, fetch its QR, and make sure each session delivers to OpenReply's
 * webhook. Message sending lives in provider.ts; this is the control plane.
 */

import { getBaseUrl } from "@/lib/env";
import { WhatsAppProviderError } from "@/lib/whatsapp/provider";

export type OpenWaSessionStatus =
  | "created"
  | "initializing"
  | "qr_ready"
  | "authenticating"
  | "ready"
  | "disconnected"
  | "failed";

export interface OpenWaSession {
  id: string;
  name: string;
  status: OpenWaSessionStatus;
  phone?: string | null;
  pushName?: string | null;
  connectedAt?: string | null;
  lastError?: string | null;
}

interface OpenWaWebhook {
  id: string;
  url: string;
  events?: string[];
}

/** Session names: OpenWA accepts letters, numbers and hyphens, 3–50 chars. */
export const SESSION_NAME_PATTERN = /^[A-Za-z0-9-]{3,50}$/;

export const OPENWA_WEBHOOK_EVENTS = [
  "message.received",
  "session.status",
  "session.disconnected",
];

export function isOpenWaConfigured() {
  return Boolean(process.env.OPENWA_BASE_URL && process.env.OPENWA_API_KEY);
}

export function getOpenReplyWebhookUrl() {
  return `${getBaseUrl().replace(/\/$/, "")}/api/whatsapp/webhook`;
}

async function request<T>(
  path: string,
  init: { method?: string; body?: unknown } = {}
): Promise<T> {
  const baseUrl = process.env.OPENWA_BASE_URL;
  const apiKey = process.env.OPENWA_API_KEY;
  if (!baseUrl || !apiKey) {
    throw new WhatsAppProviderError("OpenWA is not configured");
  }

  let response: Response;
  try {
    response = await fetch(`${baseUrl.replace(/\/$/, "")}/api${path}`, {
      method: init.method ?? "GET",
      headers: {
        "X-API-Key": apiKey,
        ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown error";
    throw new WhatsAppProviderError(`OpenWA unreachable: ${reason}`);
  }

  if (!response.ok) {
    throw new WhatsAppProviderError(
      `OpenWA ${init.method ?? "GET"} ${path} failed: ${response.status} ${(
        await response.text()
      ).slice(0, 200)}`,
      response.status
    );
  }

  if (response.status === 204) return undefined as T;
  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

function asArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  const data = (value as { data?: unknown } | null)?.data;
  return Array.isArray(data) ? (data as T[]) : [];
}

export const openWa = {
  listSessions: async () =>
    asArray<OpenWaSession>(await request<unknown>("/sessions")),
  getSession: (id: string) =>
    request<OpenWaSession>(`/sessions/${encodeURIComponent(id)}`),
  createSession: (name: string) =>
    request<OpenWaSession>("/sessions", { method: "POST", body: { name } }),
  startSession: (id: string) =>
    request<OpenWaSession>(`/sessions/${encodeURIComponent(id)}/start`, {
      method: "POST",
    }),
  deleteSession: (id: string) =>
    request<void>(`/sessions/${encodeURIComponent(id)}`, { method: "DELETE" }),
  getQr: (id: string) =>
    request<{ qrCode: string; status: OpenWaSessionStatus }>(
      `/sessions/${encodeURIComponent(id)}/qr`
    ),
  listWebhooks: async (id: string) =>
    asArray<OpenWaWebhook>(
      await request<unknown>(`/sessions/${encodeURIComponent(id)}/webhooks`)
    ),
  createWebhook: (
    id: string,
    body: { url: string; events: string[]; secret: string }
  ) =>
    request<OpenWaWebhook>(`/sessions/${encodeURIComponent(id)}/webhooks`, {
      method: "POST",
      body,
    }),
};

/**
 * Points a session's webhook at OpenReply, once. Idempotent: an existing
 * webhook with our URL is left alone, so this is safe to call on every poll.
 */
export async function ensureOpenReplyWebhook(
  sessionId: string
): Promise<"created" | "exists"> {
  const secret = process.env.OPENWA_WEBHOOK_SECRET;
  if (!secret) {
    throw new WhatsAppProviderError(
      "OPENWA_WEBHOOK_SECRET is not set — refusing to register an unsigned webhook"
    );
  }

  const url = getOpenReplyWebhookUrl();
  const existing = await openWa.listWebhooks(sessionId);
  if (existing.some((hook) => hook.url === url)) return "exists";

  await openWa.createWebhook(sessionId, {
    url,
    events: OPENWA_WEBHOOK_EVENTS,
    secret,
  });
  return "created";
}
