/**
 * Agent relay — Unit Tests
 *
 * Forwarding verified webhooks to an external agent: config, account
 * filtering, signature format, and the queue fallback when delivery fails.
 */

import { createHmac } from "crypto";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/queue/client", () => ({ getRedisConnection: () => ({}) }));

import {
  getAgentRelayConfig,
  relayToAgent,
  selectRelayBody,
  signAgentRelay,
} from "../lib/agent-relay";

const config = { url: "https://agent.example/webhooks/openreply", secret: "s3cret", accountIds: new Set(["111"]) };

function payload(...ids: string[]) {
  return { object: "instagram", entry: ids.map((id) => ({ id, time: 1, changes: [] })) };
}

describe("getAgentRelayConfig", () => {
  it("is disabled unless both URL and secret are set", () => {
    expect(getAgentRelayConfig({})).toBeNull();
    expect(getAgentRelayConfig({ AGENT_RELAY_URL: "https://x" })).toBeNull();
    expect(getAgentRelayConfig({ AGENT_RELAY_URL: "https://x", AGENT_RELAY_SECRET: "s" })).toEqual({ url: "https://x", secret: "s", accountIds: null });
  });

  it("parses the account allow-list", () => {
    const c = getAgentRelayConfig({ AGENT_RELAY_URL: "https://x", AGENT_RELAY_SECRET: "s", AGENT_RELAY_ACCOUNT_IDS: " 1, 2 ,," });
    expect([...(c?.accountIds ?? [])]).toEqual(["1", "2"]);
  });
});

describe("signAgentRelay", () => {
  it("signs timestamp.body with HMAC-SHA256", () => {
    const expected = createHmac("sha256", "s3cret").update("1700000000.{}").digest("hex");
    expect(signAgentRelay("{}", "s3cret", 1700000000)).toBe(`t=1700000000,v1=${expected}`);
  });
});

describe("selectRelayBody", () => {
  it("forwards the original bytes when every entry is relayed", () => {
    const raw = JSON.stringify(payload("111"));
    expect(selectRelayBody(raw, JSON.parse(raw), config.accountIds)).toBe(raw);
  });

  it("strips entries for other accounts", () => {
    const raw = JSON.stringify(payload("111", "222"));
    expect(JSON.parse(selectRelayBody(raw, JSON.parse(raw), config.accountIds)!).entry.map((e: { id: string }) => e.id)).toEqual(["111"]);
  });

  it("skips deliveries with nothing for the agent", () => {
    const raw = JSON.stringify(payload("222"));
    expect(selectRelayBody(raw, JSON.parse(raw), config.accountIds)).toBeNull();
    expect(selectRelayBody("{}", { object: "page", entry: [] }, null)).toBeNull();
  });
});

describe("relayToAgent", () => {
  const raw = JSON.stringify(payload("111"));

  it("does nothing when disabled", async () => {
    const fetchImpl = vi.fn();
    expect(await relayToAgent(raw, JSON.parse(raw), { config: null, fetchImpl })).toBe("disabled");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("delivers a signed request", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    expect(await relayToAgent(raw, JSON.parse(raw), { config, fetchImpl: fetchImpl as unknown as typeof fetch })).toBe("delivered");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(config.url);
    expect(init.body).toBe(raw);
    const sig = (init.headers as Record<string, string>)["x-openreply-signature"];
    const t = Number(sig.split(",")[0].slice(2));
    expect(sig).toBe(signAgentRelay(raw, "s3cret", t));
  });

  it("queues a retry when the agent is down", async () => {
    const enqueue = vi.fn(async () => undefined);
    const fetchImpl = vi.fn(async () => new Response("down", { status: 503 }));
    expect(await relayToAgent(raw, JSON.parse(raw), { config, fetchImpl: fetchImpl as unknown as typeof fetch, enqueue })).toBe("queued");
    expect(enqueue).toHaveBeenCalledWith({ body: raw });
  });

  it("reports but never throws when even the queue is unavailable", async () => {
    const onError = vi.fn();
    const result = await relayToAgent(raw, JSON.parse(raw), {
      config,
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
      enqueue: async () => {
        throw new Error("redis down");
      },
      onError,
    });
    expect(result).toBe("failed");
    expect(onError.mock.calls[0][0]).toMatch(/ECONNREFUSED.*redis down/);
  });
});
