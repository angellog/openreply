import { beforeEach, describe, expect, it, vi } from "vitest";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    findUnique: vi.fn(),
    update: vi.fn(),
    opEventFindFirst: vi.fn(),
    opEventCreate: vi.fn(),
    decrypt: vi.fn(),
  },
}));

vi.mock("@/lib/db/client", () => ({
  prisma: {
    harveyAgent: { findUnique: mocks.findUnique, update: mocks.update },
    operationalEvent: { findFirst: mocks.opEventFindFirst, create: mocks.opEventCreate },
  },
}));
vi.mock("@/lib/meta/oauth", () => ({ decryptToken: mocks.decrypt }));

import { NextRequest } from "next/server";
import { authenticateHarveyRequest } from "@/lib/harvey/auth";
import { signHarveyBody } from "@/lib/harvey/signature";

const SECRET = "agent-secret";
const BODY = JSON.stringify({ companies: [] });

function request({
  body = BODY,
  agentId = "agent_1",
  timestamp = String(Math.floor(Date.now() / 1000)),
  signature,
}: {
  body?: string;
  agentId?: string | null;
  timestamp?: string;
  signature?: string;
} = {}) {
  const headers = new Headers({ "content-type": "application/json" });
  if (agentId) headers.set("x-harvey-agent", agentId);
  headers.set("x-harvey-timestamp", timestamp);
  headers.set("x-harvey-signature", signature ?? signHarveyBody(body, timestamp, SECRET));
  return new NextRequest("https://app.test/api/harvey/v1/sync", {
    method: "POST",
    body,
    headers,
  });
}

const ACTIVE_AGENT = {
  id: "agent_1",
  workspaceId: "ws_1",
  name: "feetbit-wholesale",
  status: "ACTIVE",
  secretEncrypted: "encrypted",
  whatsappPhone: "256727214773",
  whatsappMessage: null,
  defaultDestinationUrl: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findUnique.mockResolvedValue(ACTIVE_AGENT);
  mocks.decrypt.mockReturnValue(SECRET);
  mocks.update.mockResolvedValue({});
  mocks.opEventFindFirst.mockResolvedValue(null);
  mocks.opEventCreate.mockResolvedValue({});
});

describe("authenticateHarveyRequest", () => {
  it("accepts a correctly signed request and hands back the raw body", async () => {
    const result = await authenticateHarveyRequest(request());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.agent).toMatchObject({ id: "agent_1", workspaceId: "ws_1" });
    // The raw body must come back, because re-reading the stream would fail
    // and re-encoding would no longer match the signature.
    expect(result.rawBody).toBe(BODY);
  });

  it("records that the agent is alive", async () => {
    await authenticateHarveyRequest(request());

    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "agent_1" },
        data: { lastSeenAt: expect.any(Date) },
      })
    );
  });

  it("rejects a missing agent header without touching the database", async () => {
    const result = await authenticateHarveyRequest(request({ agentId: null }));

    expect(result).toMatchObject({ ok: false, status: 401, code: "UNKNOWN_AGENT" });
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });

  it("rejects an unknown agent quietly, since it is as likely a probe", async () => {
    mocks.findUnique.mockResolvedValue(null);

    const result = await authenticateHarveyRequest(request());

    expect(result).toMatchObject({ ok: false, code: "UNKNOWN_AGENT" });
    expect(mocks.opEventCreate).not.toHaveBeenCalled();
  });

  it("refuses a revoked agent with 403 and logs it", async () => {
    mocks.findUnique.mockResolvedValue({ ...ACTIVE_AGENT, status: "REVOKED" });

    const result = await authenticateHarveyRequest(request());

    expect(result).toMatchObject({ ok: false, status: 403, code: "AGENT_REVOKED" });
    expect(mocks.opEventCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ source: "HARVEY", level: "ERROR" }),
      })
    );
    expect(mocks.decrypt).not.toHaveBeenCalled();
  });

  it("names a rotated ENCRYPTION_KEY instead of looking like a bad signature", async () => {
    mocks.decrypt.mockImplementation(() => {
      throw new Error("unable to authenticate data");
    });

    const result = await authenticateHarveyRequest(request());

    expect(result).toMatchObject({ ok: false, code: "BAD_AGENT_SECRET" });
  });

  it("rejects a body signed with the wrong secret", async () => {
    const result = await authenticateHarveyRequest(
      request({ signature: signHarveyBody(BODY, String(Math.floor(Date.now() / 1000)), "wrong") })
    );

    expect(result).toMatchObject({ ok: false, code: "bad_signature" });
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("rejects a replayed request and says the clock is the problem", async () => {
    const old = String(Math.floor(Date.now() / 1000) - 3600);

    const result = await authenticateHarveyRequest(request({ timestamp: old }));

    expect(result).toMatchObject({ ok: false, code: "stale_timestamp" });
  });

  it("logs a given failure once an hour, not once a heartbeat", async () => {
    mocks.opEventFindFirst.mockResolvedValue({ id: "event_recent" });

    await authenticateHarveyRequest(request({ signature: "sha256=deadbeef" }));

    expect(mocks.opEventCreate).not.toHaveBeenCalled();
  });

  it("survives an operational-event write failing", async () => {
    mocks.opEventCreate.mockRejectedValue(new Error("db down"));

    const result = await authenticateHarveyRequest(request({ signature: "sha256=deadbeef" }));

    expect(result).toMatchObject({ ok: false });
  });
});
