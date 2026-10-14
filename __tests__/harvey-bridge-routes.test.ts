import { beforeEach, describe, expect, it, vi } from "vitest";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    auth: vi.fn(),
    company: { upsert: vi.fn(), findMany: vi.fn() },
    prospect: { upsert: vi.fn(), findMany: vi.fn() },
    email: { upsert: vi.fn(), findUnique: vi.fn(), update: vi.fn(), findFirst: vi.fn() },
    command: { findMany: vi.fn(), updateMany: vi.fn(), create: vi.fn(), findFirst: vi.fn() },
    agent: { update: vi.fn() },
    trackedLink: { create: vi.fn() },
    transaction: vi.fn(),
  },
}));

vi.mock("@/lib/harvey/auth", () => ({
  authenticateHarveyRequest: mocks.auth,
}));
vi.mock("@/lib/db/client", () => ({
  prisma: {
    $transaction: mocks.transaction,
    harveyCompany: mocks.company,
    harveyProspect: mocks.prospect,
    harveyEmail: mocks.email,
    harveyCommand: mocks.command,
    harveyAgent: mocks.agent,
    trackedLink: mocks.trackedLink,
  },
}));

import { NextRequest } from "next/server";
import { POST as sync } from "../app/api/harvey/v1/sync/route";
import { POST as mintLink } from "../app/api/harvey/v1/links/route";

const AGENT = {
  id: "agent_1",
  workspaceId: "ws_1",
  name: "feetbit-wholesale",
  whatsappPhone: "256727214773",
  whatsappMessage: "Hi! I got your email",
  defaultDestinationUrl: null as string | null,
};

function signedRequest(url: string, body: unknown) {
  const rawBody = JSON.stringify(body);
  mocks.auth.mockResolvedValue({ ok: true, agent: AGENT, rawBody });
  return new NextRequest(url, { method: "POST", body: rawBody });
}

beforeEach(() => {
  vi.clearAllMocks();
  // The route batches its writes, so the mock has to actually run the batch
  // for the per-write assertions below to mean anything.
  mocks.transaction.mockImplementation((operations: Promise<unknown>[]) =>
    Promise.all(operations)
  );
  mocks.company.upsert.mockResolvedValue({});
  mocks.prospect.upsert.mockResolvedValue({});
  mocks.email.upsert.mockResolvedValue({});
  mocks.company.findMany.mockResolvedValue([]);
  mocks.prospect.findMany.mockResolvedValue([]);
  mocks.command.findMany.mockResolvedValue([]);
  mocks.command.updateMany.mockResolvedValue({ count: 0 });
  mocks.agent.update.mockResolvedValue({});
});

describe("POST /api/harvey/v1/sync", () => {
  it("refuses an unauthenticated agent with the reason", async () => {
    mocks.auth.mockResolvedValue({ ok: false, status: 401, code: "stale_timestamp" });

    const response = await sync(
      new NextRequest("https://app.test/api/harvey/v1/sync", { method: "POST", body: "{}" })
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ code: "stale_timestamp" });
    expect(mocks.company.upsert).not.toHaveBeenCalled();
  });

  it("refuses a revoked agent with 403", async () => {
    mocks.auth.mockResolvedValue({ ok: false, status: 403, code: "AGENT_REVOKED" });

    const response = await sync(
      new NextRequest("https://app.test/api/harvey/v1/sync", { method: "POST", body: "{}" })
    );

    expect(response.status).toBe(403);
  });

  it("names the offending field instead of refusing silently", async () => {
    const response = await sync(
      signedRequest("https://app.test/api/harvey/v1/sync", {
        prospects: [{ harveyId: "p1", email: "a@b.co", score: 900 }],
      })
    );

    expect(response.status).toBe(422);
    const json = await response.json();
    expect(json.issues?.length).toBeGreaterThan(0);
    expect(mocks.prospect.upsert).not.toHaveBeenCalled();
  });

  it("upserts keyed by (agentId, harveyId) so a replayed batch is a no-op", async () => {
    mocks.company.upsert.mockResolvedValue({});

    await sync(
      signedRequest("https://app.test/api/harvey/v1/sync", {
        companies: [{ harveyId: "c1", name: "Kampala Kicks", domain: "kampalakicks.ug" }],
      })
    );

    expect(mocks.company.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { agentId_harveyId: { agentId: "agent_1", harveyId: "c1" } },
      })
    );
  });

  it("resolves Harvey's own company id to the local row", async () => {
    mocks.company.findMany.mockResolvedValue([{ id: "local_c1", harveyId: "c1" }]);
    mocks.prospect.upsert.mockResolvedValue({});

    await sync(
      signedRequest("https://app.test/api/harvey/v1/sync", {
        prospects: [{ harveyId: "p1", companyHarveyId: "c1", email: "buyer@kampalakicks.ug" }],
      })
    );

    expect(mocks.prospect.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ companyId: "local_c1" }),
      })
    );
  });

  it("leaves the company null when Harvey references one it never sent", async () => {
    mocks.company.findMany.mockResolvedValue([]);
    mocks.prospect.upsert.mockResolvedValue({});

    await sync(
      signedRequest("https://app.test/api/harvey/v1/sync", {
        prospects: [{ harveyId: "p1", companyHarveyId: "ghost", email: "a@b.co" }],
      })
    );

    expect(mocks.prospect.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ companyId: null }) })
    );
  });

  it("maps Harvey's lower-case status onto the enum", async () => {
    mocks.email.upsert.mockResolvedValue({});

    await sync(
      signedRequest("https://app.test/api/harvey/v1/sync", {
        emails: [
          { harveyId: "o1", toEmail: "a@b.co", subject: "quick one", body: "hi", status: "sent" },
        ],
      })
    );

    expect(mocks.email.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ status: "SENT" }) })
    );
  });

  it("acks only this agent's unacked commands", async () => {
    mocks.command.updateMany.mockResolvedValue({ count: 1 });

    const response = await sync(
      signedRequest("https://app.test/api/harvey/v1/sync", {
        acks: [{ commandId: "cmd_1", result: "approved" }],
      })
    );

    expect(mocks.command.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "cmd_1", agentId: "agent_1", ackedAt: null },
      })
    );
    await expect(response.json()).resolves.toMatchObject({
      data: { counts: { acked: 1 } },
    });
  });

  it("hands over pending commands and stamps first delivery only", async () => {
    const expiresAt = new Date("2026-10-20T00:00:00.000Z");
    mocks.command.findMany.mockResolvedValue([
      { id: "cmd_1", kind: "APPROVE_EMAIL", targetHarveyId: "o1", payload: null, createdAt: new Date(), expiresAt },
    ]);

    const response = await sync(signedRequest("https://app.test/api/harvey/v1/sync", {}));
    const json = await response.json();

    expect(json.data.commands).toEqual([
      {
        id: "cmd_1",
        kind: "APPROVE_EMAIL",
        targetHarveyId: "o1",
        payload: null,
        expiresAt: expiresAt.toISOString(),
      },
    ]);
    expect(mocks.command.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ["cmd_1"] }, deliveredAt: null },
      })
    );
  });

  it("never hands over an expired command", async () => {
    await sync(signedRequest("https://app.test/api/harvey/v1/sync", {}));

    const where = mocks.command.findMany.mock.calls[0][0].where;
    expect(where.ackedAt).toBeNull();
    expect(where.expiresAt.gt).toBeInstanceOf(Date);
  });

  it("batches its writes instead of awaiting each row", async () => {
    // 200 rows per table against Postgres in another region is seconds of
    // round trips if each one is awaited separately — long enough to risk the
    // function's own timeout. One batch per group, and emails share with acks.
    await sync(
      signedRequest("https://app.test/api/harvey/v1/sync", {
        companies: Array.from({ length: 50 }, (_, i) => ({ harveyId: `c${i}`, name: `Co ${i}` })),
        prospects: Array.from({ length: 50 }, (_, i) => ({
          harveyId: `p${i}`,
          email: `p${i}@example.test`,
        })),
        emails: Array.from({ length: 50 }, (_, i) => ({
          harveyId: `o${i}`,
          toEmail: `p${i}@example.test`,
        })),
        acks: [{ commandId: "cmd_1", result: "approved" }],
      })
    );

    expect(mocks.transaction).toHaveBeenCalledTimes(3);
    expect(mocks.transaction.mock.calls[0][0]).toHaveLength(50);
    expect(mocks.transaction.mock.calls[1][0]).toHaveLength(50);
    // 50 emails + 1 ack
    expect(mocks.transaction.mock.calls[2][0]).toHaveLength(51);
  });

  it("writes nothing and opens no transaction for an empty heartbeat", async () => {
    await sync(signedRequest("https://app.test/api/harvey/v1/sync", {}));

    expect(mocks.transaction).not.toHaveBeenCalled();
    // The heartbeat still counts as the agent being alive.
    expect(mocks.agent.update).toHaveBeenCalled();
  });

  it("records the reported runtime so diagnostics can show it", async () => {
    await sync(
      signedRequest("https://app.test/api/harvey/v1/sync", {
        runtime: { version: "0.3.0", brainProvider: "claude" },
      })
    );

    expect(mocks.agent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ agentVersion: "0.3.0", brainProvider: "claude" }),
      })
    );
  });
});

describe("POST /api/harvey/v1/links", () => {
  it("returns the existing link rather than minting a second one", async () => {
    mocks.email.findUnique.mockResolvedValue({
      id: "e1",
      trackedLink: { slug: "hv_existing" },
    });

    const response = await mintLink(
      signedRequest("https://app.test/api/harvey/v1/links", { emailHarveyId: "o1" })
    );
    const json = await response.json();

    expect(json.data).toMatchObject({ slug: "hv_existing", reused: true });
    expect(mocks.trackedLink.create).not.toHaveBeenCalled();
  });

  it("refuses to mint for an email it has never seen", async () => {
    mocks.email.findUnique.mockResolvedValue(null);

    const response = await mintLink(
      signedRequest("https://app.test/api/harvey/v1/links", { emailHarveyId: "ghost" })
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ code: "UNKNOWN_EMAIL" });
  });

  it("builds the wa.me destination from the agent's own number, with the ref", async () => {
    mocks.email.findUnique.mockResolvedValue({ id: "e1", trackedLink: null });
    mocks.trackedLink.create.mockImplementation(async ({ data }: never) => ({
      id: "link_1",
      slug: (data as { slug: string }).slug,
    }));
    mocks.email.update.mockResolvedValue({});

    const response = await mintLink(
      signedRequest("https://app.test/api/harvey/v1/links", { emailHarveyId: "o1" })
    );
    const json = await response.json();

    const created = mocks.trackedLink.create.mock.calls[0][0].data;
    expect(created.source).toBe("HARVEY_EMAIL");
    expect(created.automationId).toBeNull();
    expect(created.destinationUrl).toContain("wa.me/256727214773");
    expect(decodeURIComponent(created.destinationUrl)).toContain(`(ref: ${json.data.slug})`);
    expect(mocks.email.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { trackedLinkId: "link_1" } })
    );
  });

  it("refuses a WhatsApp link when the agent has no number, and says what to do", async () => {
    mocks.email.findUnique.mockResolvedValue({ id: "e1", trackedLink: null });
    const rawBody = JSON.stringify({ emailHarveyId: "o1" });
    mocks.auth.mockResolvedValue({
      ok: true,
      agent: { ...AGENT, whatsappPhone: null },
      rawBody,
    });

    const response = await mintLink(
      new NextRequest("https://app.test/api/harvey/v1/links", { method: "POST", body: rawBody })
    );

    expect(response.status).toBe(409);
    const json = await response.json();
    expect(json.code).toBe("NO_DESTINATION");
    expect(json.error).toContain("Outreach settings");
    expect(mocks.trackedLink.create).not.toHaveBeenCalled();
  });

  it("uses the agent's booking page for a default-destination link", async () => {
    mocks.email.findUnique.mockResolvedValue({ id: "e1", trackedLink: null });
    mocks.trackedLink.create.mockResolvedValue({ id: "link_2", slug: "hv_cal" });
    mocks.email.update.mockResolvedValue({});
    const rawBody = JSON.stringify({ emailHarveyId: "o1", destination: "default" });
    mocks.auth.mockResolvedValue({
      ok: true,
      agent: { ...AGENT, defaultDestinationUrl: "https://cal.com/vantik/intro" },
      rawBody,
    });

    await mintLink(
      new NextRequest("https://app.test/api/harvey/v1/links", { method: "POST", body: rawBody })
    );

    expect(mocks.trackedLink.create.mock.calls[0][0].data.destinationUrl).toBe(
      "https://cal.com/vantik/intro"
    );
  });
});
