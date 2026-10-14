import { beforeEach, describe, expect, it, vi } from "vitest";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    context: vi.fn(),
    agent: { findMany: vi.fn(), findFirst: vi.fn(), upsert: vi.fn(), update: vi.fn() },
    opEvent: { create: vi.fn() },
    encrypt: vi.fn(),
  },
}));

vi.mock("@/lib/workspace-access", () => ({
  getCurrentWorkspaceContext: mocks.context,
  canManageWorkspace: (role: string) => role === "OWNER" || role === "ADMIN",
}));
vi.mock("@/lib/db/client", () => ({
  prisma: { harveyAgent: mocks.agent, operationalEvent: mocks.opEvent },
}));
vi.mock("@/lib/meta/oauth", () => ({ encryptToken: mocks.encrypt }));

import { NextRequest } from "next/server";
import { GET, PATCH, POST } from "../app/api/outreach/agents/route";

function post(body: unknown) {
  return POST(
    new NextRequest("https://app.test/api/outreach/agents", {
      method: "POST",
      body: JSON.stringify(body),
    })
  );
}

function patch(body: unknown) {
  return PATCH(
    new NextRequest("https://app.test/api/outreach/agents", {
      method: "PATCH",
      body: JSON.stringify(body),
    })
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.context.mockResolvedValue({
    userId: "user_1",
    workspaceId: "ws_1",
    role: "OWNER",
    workspace: {},
  });
  // Opaque on purpose: a mock that echoed the plaintext would make the
  // "secret is never stored in the clear" assertion below vacuous.
  mocks.encrypt.mockReturnValue("CIPHERTEXT");
  mocks.opEvent.create.mockResolvedValue({});
  mocks.agent.findMany.mockResolvedValue([]);
});

describe("GET /api/outreach/agents", () => {
  it("calls an agent online only if it checked in recently", async () => {
    mocks.agent.findMany.mockResolvedValue([
      { id: "a1", name: "fresh", lastSeenAt: new Date(), _count: {} },
      {
        id: "a2",
        name: "asleep",
        lastSeenAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
        _count: {},
      },
      { id: "a3", name: "never", lastSeenAt: null, _count: {} },
    ]);

    const json = await (await GET()).json();

    expect(json.data.agents.map((a: { online: boolean }) => a.online)).toEqual([
      true,
      false,
      false,
    ]);
  });
});

describe("POST /api/outreach/agents", () => {
  it("issues a secret once, stores only the ciphertext, and keeps a prefix", async () => {
    mocks.agent.upsert.mockImplementation(async ({ create }: never) => ({
      id: "a1",
      name: (create as { name: string }).name,
      secretPrefix: (create as { secretPrefix: string }).secretPrefix,
      createdAt: new Date(),
    }));

    const json = await (await post({ name: "feetbit-wholesale" })).json();

    const stored = mocks.agent.upsert.mock.calls[0][0].create;
    expect(mocks.encrypt).toHaveBeenCalledWith(json.data.secret);
    expect(stored.secretEncrypted).toBe("CIPHERTEXT");
    // The plaintext must never reach a column. The 6-char display prefix is
    // short enough not to match the full secret.
    expect(JSON.stringify(stored)).not.toContain(json.data.secret);
    expect(json.data.secret.length).toBeGreaterThan(30);
    expect(stored.secretPrefix).toBe(json.data.secret.slice(0, 6));
    expect(json.data.env).toEqual({
      OPENREPLY_AGENT_ID: "a1",
      OPENREPLY_AGENT_SECRET: json.data.secret,
    });
  });

  it("scopes the agent name to the workspace", async () => {
    mocks.agent.upsert.mockResolvedValue({ id: "a1", name: "vantik", secretPrefix: "abc123" });

    await post({ name: "vantik" });

    expect(mocks.agent.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId_name: { workspaceId: "ws_1", name: "vantik" } },
      })
    );
  });

  it("rotating a revoked agent's secret brings it back", async () => {
    mocks.agent.upsert.mockResolvedValue({ id: "a1", name: "vantik", secretPrefix: "abc123" });

    await post({ name: "vantik" });

    expect(mocks.agent.upsert.mock.calls[0][0].update.status).toBe("ACTIVE");
  });

  it("rejects a name that would be awkward in a URL or a config file", async () => {
    for (const name of ["Feet Bit", "a", "UPPER", "has_underscore", "-leading"]) {
      const response = await post({ name });
      expect(response.status, name).toBe(422);
    }
    expect(mocks.agent.upsert).not.toHaveBeenCalled();
  });

  it("will not let a plain member pair an agent", async () => {
    mocks.context.mockResolvedValue({
      userId: "user_2",
      workspaceId: "ws_1",
      role: "MEMBER",
      workspace: {},
    });

    const response = await post({ name: "feetbit-wholesale" });

    expect(response.status).toBe(403);
    expect(mocks.agent.upsert).not.toHaveBeenCalled();
  });

  it("records the issue in the operational log", async () => {
    mocks.agent.upsert.mockResolvedValue({ id: "a1", name: "vantik", secretPrefix: "abc123" });

    await post({ name: "vantik" });

    expect(mocks.opEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ source: "HARVEY", level: "INFO" }),
      })
    );
  });
});

describe("PATCH /api/outreach/agents", () => {
  beforeEach(() => {
    mocks.agent.findFirst.mockResolvedValue({ id: "a1", name: "feetbit-wholesale" });
    mocks.agent.update.mockResolvedValue({ id: "a1", name: "feetbit-wholesale", status: "ACTIVE" });
  });

  it("stores a WhatsApp number as digits, the way wa.me needs it", async () => {
    await patch({ agentId: "a1", whatsappPhone: "+256 789 652 909" });

    expect(mocks.agent.update.mock.calls[0][0].data.whatsappPhone).toBe("256789652909");
  });

  it("clears a destination when given null, and leaves untouched fields alone", async () => {
    await patch({ agentId: "a1", whatsappPhone: null });

    const data = mocks.agent.update.mock.calls[0][0].data;
    expect(data.whatsappPhone).toBeNull();
    expect(data).not.toHaveProperty("defaultDestinationUrl");
    expect(data).not.toHaveProperty("status");
  });

  it("refuses a booking URL that is not a URL", async () => {
    const response = await patch({ agentId: "a1", defaultDestinationUrl: "cal.com/vantik" });

    expect(response.status).toBe(422);
    expect(mocks.agent.update).not.toHaveBeenCalled();
  });

  it("logs a revocation as a warning, since sending stops", async () => {
    mocks.agent.update.mockResolvedValue({ id: "a1", name: "feetbit-wholesale", status: "REVOKED" });

    await patch({ agentId: "a1", status: "REVOKED" });

    expect(mocks.opEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ level: "WARNING" }),
      })
    );
  });

  it("cannot touch an agent in another workspace", async () => {
    mocks.agent.findFirst.mockResolvedValue(null);

    const response = await patch({ agentId: "a_other", status: "REVOKED" });

    expect(response.status).toBe(404);
    expect(mocks.agent.update).not.toHaveBeenCalled();
  });
});
