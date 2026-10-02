import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureOpenReplyWebhook, getOpenReplyWebhookUrl } from "@/lib/whatsapp/openwa";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("OPENWA_BASE_URL", "https://openwa.test");
  vi.stubEnv("OPENWA_API_KEY", "key");
  vi.stubEnv("OPENWA_WEBHOOK_SECRET", "secret");
  vi.stubEnv("NEXTAUTH_URL", "https://app.test");
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

describe("ensureOpenReplyWebhook", () => {
  it("creates the webhook, signed and subscribed to messages and session status", async () => {
    fetchMock
      .mockResolvedValueOnce(json([]))
      .mockResolvedValueOnce(json({ id: "wh_1", url: getOpenReplyWebhookUrl() }, 201));

    await expect(ensureOpenReplyWebhook("sess_1")).resolves.toBe("created");

    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe("https://openwa.test/api/sessions/sess_1/webhooks");
    expect(init.headers["X-API-Key"]).toBe("key");
    const body = JSON.parse(init.body);
    expect(body.url).toBe("https://app.test/api/whatsapp/webhook");
    expect(body.secret).toBe("secret");
    expect(body.events).toEqual(
      expect.arrayContaining(["message.received", "session.disconnected"])
    );
  });

  it("is idempotent: an existing webhook with our URL is left alone", async () => {
    fetchMock.mockResolvedValueOnce(
      json([{ id: "wh_1", url: "https://app.test/api/whatsapp/webhook" }])
    );

    await expect(ensureOpenReplyWebhook("sess_1")).resolves.toBe("exists");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses to register an unsigned webhook", async () => {
    vi.stubEnv("OPENWA_WEBHOOK_SECRET", "");
    await expect(ensureOpenReplyWebhook("sess_1")).rejects.toThrow(/OPENWA_WEBHOOK_SECRET/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces gateway errors with the status", async () => {
    fetchMock.mockResolvedValueOnce(new Response("nope", { status: 401 }));
    await expect(ensureOpenReplyWebhook("sess_1")).rejects.toMatchObject({ status: 401 });
  });
});
