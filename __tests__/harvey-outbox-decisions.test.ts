import { beforeEach, describe, expect, it, vi } from "vitest";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    context: vi.fn(),
    email: { findMany: vi.fn(), findFirst: vi.fn() },
    command: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
  },
}));

// Mocked outright rather than partially: the real module pulls in next-auth,
// which does not resolve under vitest.
vi.mock("@/lib/workspace-access", () => ({
  getCurrentWorkspaceContext: mocks.context,
  canManageWorkspace: () => true,
}));
vi.mock("@/lib/db/client", () => ({
  prisma: { harveyEmail: mocks.email, harveyCommand: mocks.command },
}));

import { NextRequest } from "next/server";
import { GET, POST } from "../app/api/outreach/outbox/route";
import { EMAIL_STALE_AFTER_MS } from "@/lib/harvey/sync";

function decide(body: unknown) {
  return POST(
    new NextRequest("https://app.test/api/outreach/outbox", {
      method: "POST",
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
  mocks.command.findMany.mockResolvedValue([]);
  mocks.email.findMany.mockResolvedValue([]);
});

describe("GET /api/outreach/outbox", () => {
  it("turns away a request with no session", async () => {
    mocks.context.mockResolvedValue(null);

    const response = await GET(new NextRequest("https://app.test/api/outreach/outbox"));

    expect(response.status).toBe(401);
    expect(mocks.email.findMany).not.toHaveBeenCalled();
  });

  it("flags a pending email that has gone stale", async () => {
    mocks.email.findMany.mockResolvedValue([
      {
        id: "e_old",
        harveyId: "o1",
        status: "PENDING_REVIEW",
        createdAt: new Date(Date.now() - EMAIL_STALE_AFTER_MS - 1000),
        trackedLink: null,
        prospect: null,
      },
      {
        id: "e_new",
        harveyId: "o2",
        status: "PENDING_REVIEW",
        createdAt: new Date(),
        trackedLink: null,
        prospect: null,
      },
    ]);

    const json = await (
      await GET(new NextRequest("https://app.test/api/outreach/outbox"))
    ).json();

    expect(json.data.emails[0]).toMatchObject({ id: "e_old", stale: true });
    expect(json.data.emails[1]).toMatchObject({ id: "e_new", stale: false });
  });

  it("does not call an already-sent email stale, however old it is", async () => {
    mocks.email.findMany.mockResolvedValue([
      {
        id: "e_sent",
        harveyId: "o1",
        status: "SENT",
        createdAt: new Date("2020-01-01T00:00:00.000Z"),
        trackedLink: null,
        prospect: null,
      },
    ]);

    const json = await (
      await GET(new NextRequest("https://app.test/api/outreach/outbox"))
    ).json();

    expect(json.data.emails[0].stale).toBe(false);
  });

  it("marks an email whose decision Harvey has not collected yet", async () => {
    const issuedAt = new Date();
    mocks.email.findMany.mockResolvedValue([
      {
        id: "e1",
        harveyId: "o1",
        status: "PENDING_REVIEW",
        createdAt: new Date(),
        trackedLink: null,
        prospect: null,
      },
    ]);
    mocks.command.findMany.mockResolvedValue([
      {
        kind: "APPROVE_EMAIL",
        targetHarveyId: "o1",
        createdAt: issuedAt,
        deliveredAt: null,
      },
    ]);

    const json = await (
      await GET(new NextRequest("https://app.test/api/outreach/outbox"))
    ).json();

    expect(json.data.emails[0].pendingDecision).toMatchObject({
      kind: "APPROVE_EMAIL",
      deliveredAt: null,
    });
  });

  it("exposes the tracked link as a clickable url", async () => {
    mocks.email.findMany.mockResolvedValue([
      {
        id: "e1",
        harveyId: "o1",
        status: "PENDING_REVIEW",
        createdAt: new Date(),
        trackedLink: { slug: "hv_abc123" },
        prospect: null,
      },
    ]);

    const json = await (
      await GET(new NextRequest("https://app.test/api/outreach/outbox"))
    ).json();

    expect(json.data.emails[0].trackedUrl).toContain("/r/hv_abc123");
  });
});

describe("POST /api/outreach/outbox", () => {
  it("queues an approval for Harvey to collect", async () => {
    mocks.email.findFirst.mockResolvedValue({
      id: "e1",
      harveyId: "o1",
      agentId: "agent_1",
      status: "PENDING_REVIEW",
      toEmail: "buyer@kampalakicks.ug",
    });
    mocks.command.findFirst.mockResolvedValue(null);
    mocks.command.create.mockResolvedValue({
      id: "cmd_1",
      kind: "APPROVE_EMAIL",
      expiresAt: new Date(),
    });

    const response = await decide({ emailId: "e1", decision: "APPROVE" });

    expect(response.status).toBe(200);
    expect(mocks.command.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          agentId: "agent_1",
          kind: "APPROVE_EMAIL",
          targetHarveyId: "o1",
          issuedByUserId: "user_1",
        }),
      })
    );
  });

  it("refuses to decide an email Harvey has already sent", async () => {
    mocks.email.findFirst.mockResolvedValue({
      id: "e1",
      harveyId: "o1",
      agentId: "agent_1",
      status: "SENT",
      toEmail: "buyer@kampalakicks.ug",
    });

    const response = await decide({ emailId: "e1", decision: "APPROVE" });

    expect(response.status).toBe(409);
    const json = await response.json();
    expect(json.code).toBe("NOT_PENDING");
    expect(json.error).toContain("already sent");
    expect(mocks.command.create).not.toHaveBeenCalled();
  });

  it("does not queue a second command when one is already in flight", async () => {
    mocks.email.findFirst.mockResolvedValue({
      id: "e1",
      harveyId: "o1",
      agentId: "agent_1",
      status: "PENDING_REVIEW",
      toEmail: "buyer@kampalakicks.ug",
    });
    mocks.command.findFirst.mockResolvedValue({ id: "cmd_existing", kind: "APPROVE_EMAIL" });

    const json = await (await decide({ emailId: "e1", decision: "APPROVE" })).json();

    expect(json.data).toMatchObject({ commandId: "cmd_existing", reused: true });
    expect(mocks.command.create).not.toHaveBeenCalled();
  });

  it("cannot decide an email in someone else's workspace", async () => {
    mocks.email.findFirst.mockResolvedValue(null);

    const response = await decide({ emailId: "e_other", decision: "APPROVE" });

    expect(response.status).toBe(404);
    // The lookup is scoped, so a foreign id is indistinguishable from a missing one.
    expect(mocks.email.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "e_other", workspaceId: "ws_1" } })
    );
  });

  it("rejects an unknown decision", async () => {
    const response = await decide({ emailId: "e1", decision: "MAYBE" });

    expect(response.status).toBe(422);
    expect(mocks.email.findFirst).not.toHaveBeenCalled();
  });
});
