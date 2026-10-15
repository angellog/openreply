import { beforeEach, describe, expect, it, vi } from "vitest";

const { mocks } = vi.hoisted(() => ({
  mocks: { findMany: vi.fn(), create: vi.fn(), emailFindFirst: vi.fn() },
}));

vi.mock("@/lib/db/client", () => ({
  prisma: {
    outreachEvent: { findMany: mocks.findMany, create: mocks.create },
    harveyEmail: { findFirst: mocks.emailFindFirst },
  },
}));

import {
  EVENT_SETTLE_MS,
  readOutreachEvents,
  recordOutreachEvent,
} from "@/lib/outreach/events";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.create.mockResolvedValue({});
  mocks.findMany.mockResolvedValue([]);
});

describe("recordOutreachEvent", () => {
  it("writes the event with its Harvey ids", async () => {
    await recordOutreachEvent({
      workspaceId: "ws_1",
      agentId: "agent_1",
      type: "LINK_CLICKED",
      emailHarveyId: "o1",
      prospectHarveyId: "p1",
      trackedLinkSlug: "hv_abc",
      payload: { step: 2 },
    });

    expect(mocks.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: "ws_1",
        agentId: "agent_1",
        type: "LINK_CLICKED",
        emailHarveyId: "o1",
        prospectHarveyId: "p1",
      }),
    });
  });

  it("never throws, because the thing that caused it must still finish", async () => {
    // A redirect still has to redirect and a WhatsApp reply still has to send.
    mocks.create.mockRejectedValue(new Error("db down"));

    await expect(
      recordOutreachEvent({ workspaceId: "ws_1", type: "LINK_CLICKED" })
    ).resolves.toBeUndefined();
  });
});

describe("readOutreachEvents", () => {
  it("asks for events after the cursor, oldest first", async () => {
    await readOutreachEvents({ agentId: "agent_1", workspaceId: "ws_1", since: 42 });

    const call = mocks.findMany.mock.calls[0][0];
    expect(call.where.seq).toEqual({ gt: 42 });
    expect(call.orderBy).toEqual({ seq: "asc" });
  });

  it("ignores the last couple of seconds so out-of-order commits settle", async () => {
    // Postgres hands out a seq before the transaction commits, so a reader
    // taking the highest seq it sees could skip a lower one committing a
    // moment later. That row would then be behind the cursor forever.
    const now = new Date("2026-10-15T09:00:10.000Z");
    await readOutreachEvents({ agentId: "agent_1", workspaceId: "ws_1", since: 0, now });

    expect(mocks.findMany.mock.calls[0][0].where.createdAt).toEqual({
      lt: new Date(now.getTime() - EVENT_SETTLE_MS),
    });
  });

  it("offers an agent its own events plus the unassigned ones", async () => {
    await readOutreachEvents({ agentId: "agent_1", workspaceId: "ws_1", since: 0 });

    expect(mocks.findMany.mock.calls[0][0].where.OR).toEqual([
      { agentId: "agent_1" },
      { agentId: null },
    ]);
  });

  it("stays inside the workspace", async () => {
    await readOutreachEvents({ agentId: "agent_1", workspaceId: "ws_1", since: 0 });

    expect(mocks.findMany.mock.calls[0][0].where.workspaceId).toBe("ws_1");
  });

  it("caps how much one poll can drag back", async () => {
    await readOutreachEvents({ agentId: "a", workspaceId: "w", since: 0, limit: 5000 });

    expect(mocks.findMany.mock.calls[0][0].take).toBe(200);
  });
});
