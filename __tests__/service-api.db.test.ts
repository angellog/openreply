/**
 * The service API against a real Postgres: the unique externalRef index, the
 * concurrent-create race, and the grouped stats queries — the parts a mock
 * cannot prove.
 *
 * Skipped unless SERVICE_API_TEST_DATABASE_URL points at a local database
 * whose name ends in "_test", migrated with `prisma migrate deploy`. It
 * deletes what it creates, and refuses to run anywhere else:
 *
 *   createdb openreply_service_api_test
 *   DATABASE_URL=postgresql://localhost:5432/openreply_service_api_test npx prisma migrate deploy
 *   SERVICE_API_TEST_DATABASE_URL=postgresql://localhost:5432/openreply_service_api_test npx vitest run __tests__/service-api.db.test.ts
 */

import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const DB_URL = process.env.SERVICE_API_TEST_DATABASE_URL ?? "";

function isSafeTestDatabase(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      ["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname) &&
      parsed.pathname.replace(/^\//, "").endsWith("_test")
    );
  } catch {
    return false;
  }
}

if (DB_URL && !isSafeTestDatabase(DB_URL)) {
  throw new Error(
    "SERVICE_API_TEST_DATABASE_URL must be a localhost database whose name ends in _test"
  );
}

// lib/db/client builds its client lazily from DATABASE_URL on first use.
if (DB_URL) process.env.DATABASE_URL = DB_URL;

import { NextRequest } from "next/server";

const run = describe.skipIf(!DB_URL);

run("service API on Postgres", () => {
  const TOKEN = randomBytes(32).toString("hex");
  const suffix = randomBytes(4).toString("hex");
  const BASE = "https://openreply.test/api/service/v1";
  const REF = `kickshot:dbtest-${suffix}:feetbit.sneakers`;

  let ownerId = "";
  let workspaceId = "";
  let accountId = "";
  let routes: {
    accounts: typeof import("../app/api/service/v1/accounts/route");
    campaigns: typeof import("../app/api/service/v1/campaigns/route");
    campaign: typeof import("../app/api/service/v1/campaigns/[externalRef]/route");
  };
  let prisma: typeof import("@/lib/db/client").prisma;

  const req = (url: string, method = "GET", body?: unknown) =>
    new NextRequest(url, {
      method,
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
        "x-forwarded-for": "127.0.0.1",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const ctx = (ref: string) => ({ params: Promise.resolve({ externalRef: ref }) });

  beforeAll(async () => {
    vi.stubEnv("REDIS_URL", "");
    vi.stubEnv("NEXTAUTH_URL", "https://openreply.test");
    vi.stubEnv("OPENREPLY_SERVICE_RATE_LIMIT_PER_MINUTE", "1000");
    ({ prisma } = await import("@/lib/db/client"));

    const owner = await prisma.user.create({
      data: { email: `service-api-${suffix}@test.invalid` },
    });
    ownerId = owner.id;
    const workspace = await prisma.workspace.create({
      data: { name: `Service API test ${suffix}`, ownerId },
    });
    workspaceId = workspace.id;
    const account = await prisma.instagramAccount.create({
      data: {
        workspaceId,
        instagramId: `test-${suffix}`,
        username: "feetbit.sneakers",
        accessToken: "encrypted-test-token",
        tokenExpiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
        webhookSubscribed: true,
      },
    });
    accountId = account.id;

    vi.stubEnv("OPENREPLY_SERVICE_TOKEN_SHA256", createHash("sha256").update(TOKEN).digest("hex"));
    vi.stubEnv("OPENREPLY_SERVICE_WORKSPACE_ID", workspaceId);

    routes = {
      accounts: await import("../app/api/service/v1/accounts/route"),
      campaigns: await import("../app/api/service/v1/campaigns/route"),
      campaign: await import("../app/api/service/v1/campaigns/[externalRef]/route"),
    };
  });

  afterAll(async () => {
    // Deleting the owner cascades to the workspace and everything in it.
    if (ownerId) await prisma.user.delete({ where: { id: ownerId } });
    vi.unstubAllEnvs();
  });

  const body = {
    externalRef: REF,
    instagramUsername: "feetbit.sneakers",
    name: "WALL reel",
    keywords: ["WALL"],
    dmMessage: "Here you go {username}",
    trackedDestinationUrl: "https://feetbitsneakers.com/wall",
  };

  it("lists the connected account", async () => {
    const res = await routes.accounts.GET(req(`${BASE}/accounts`));
    const { accounts } = await res.json();
    expect(accounts).toEqual([
      expect.objectContaining({ id: accountId, username: "feetbit.sneakers", connected: true, canPrivateReply: true }),
    ]);
  });

  it("creates once, then returns the same campaign for the same ref", async () => {
    const first = await routes.campaigns.POST(req(`${BASE}/campaigns`, "POST", body));
    expect(first.status).toBe(201);
    const created = (await first.json()).campaign;
    expect(created).toMatchObject({ externalRef: REF, isActive: false, postId: null });
    expect(created.trackedUrl).toMatch(/^https:\/\/openreply\.test\/r\/.+/);

    const again = await routes.campaigns.POST(
      req(`${BASE}/campaigns`, "POST", { ...body, dmMessage: "Second copy" })
    );
    expect(again.status).toBe(200);
    const updated = (await again.json()).campaign;
    expect(updated.id).toBe(created.id);
    expect(updated.dmMessage).toBe("Second copy");
    // Same tracked link slug: links already sent keep working.
    expect(updated.trackedUrl).toBe(created.trackedUrl);

    expect(await prisma.automation.count({ where: { workspaceId, externalRef: REF } })).toBe(1);
  });

  it("never duplicates under concurrent creates of a new ref", async () => {
    const raceRef = `${REF}:race`;
    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        routes.campaigns.POST(req(`${BASE}/campaigns`, "POST", { ...body, externalRef: raceRef }))
      )
    );
    const statuses = responses.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 200, 200, 200, 201]);
    expect(await prisma.automation.count({ where: { workspaceId, externalRef: raceRef } })).toBe(1);
  });

  it("attaches the reel, activates, and reports real stats", async () => {
    const attach = await routes.campaign.PATCH(
      req(`${BASE}/campaigns/${REF}`, "PATCH", {
        postId: `post-${suffix}`,
        postUrl: "https://www.instagram.com/reel/abc/",
      }),
      ctx(REF)
    );
    expect(attach.status).toBe(200);
    const attached = (await attach.json()).campaign;
    expect(attached).toMatchObject({ postId: `post-${suffix}`, isActive: true });

    const automation = await prisma.automation.findUniqueOrThrow({
      where: { workspaceId_externalRef: { workspaceId, externalRef: REF } },
      include: { trackedLinks: true },
    });
    const link = automation.trackedLinks[0];
    const sentAt = new Date("2026-11-25T12:30:00Z");
    const log = (n: number, status: "SENT" | "FAILED" | "SKIPPED_DEDUP") => ({
      workspaceId,
      automationId: automation.id,
      instagramAccountId: accountId,
      commenterId: `c${n}`,
      commentText: "WALL",
      commentId: `cm-${suffix}-${n}`,
      matchedKeyword: "WALL",
      status,
      dmSentAt: status === "SENT" ? new Date(sentAt.getTime() - n * 60_000) : null,
    });
    await prisma.dmLog.createMany({
      data: [log(0, "SENT"), log(1, "SENT"), log(2, "SENT"), log(3, "SENT"), log(4, "FAILED"), log(5, "SKIPPED_DEDUP")],
    });
    await prisma.linkClick.createMany({
      data: [1, 2, 3].map(() => ({
        workspaceId,
        automationId: automation.id,
        instagramAccountId: accountId,
        trackedLinkId: link.id,
      })),
    });
    await prisma.whatsAppLead.create({
      data: { workspaceId, automationId: automation.id, chatId: `2567000${suffix}@c.us`, trackedLinkId: link.id },
    });

    const res = await routes.campaign.GET(req(`${BASE}/campaigns/${REF}`), ctx(REF));
    const { campaign } = await res.json();
    expect(campaign.stats).toEqual({
      dmsSent: 4,
      dmsSkipped: 1,
      dmsFailed: 1,
      linkClicks: 3,
      ctr: 75,
      whatsappLeads: 1,
      lastDmAt: sentAt.toISOString(),
    });
  });

  it("pauses, and lists by prefix", async () => {
    const pause = await routes.campaign.PATCH(
      req(`${BASE}/campaigns/${REF}`, "PATCH", { isActive: false }),
      ctx(REF)
    );
    expect((await pause.json()).campaign.isActive).toBe(false);

    // A dashboard-built campaign in the same workspace never shows up here.
    await prisma.automation.create({
      data: {
        workspaceId,
        instagramAccountId: accountId,
        name: "Hand-built",
        keywords: ["HI"],
        dmMessage: "hi",
        matchAnyPost: true,
      },
    });

    const res = await routes.campaigns.GET(req(`${BASE}/campaigns?prefix=kickshot:dbtest-${suffix}`));
    const { campaigns } = await res.json();
    expect(campaigns.map((c: { externalRef: string }) => c.externalRef).sort()).toEqual([REF, `${REF}:race`].sort());
    const main = campaigns.find((c: { externalRef: string }) => c.externalRef === REF);
    expect(main.stats.dmsSent).toBe(4);

    const all = await routes.campaigns.GET(req(`${BASE}/campaigns`));
    expect((await all.json()).campaigns.every((c: { externalRef: string | null }) => c.externalRef)).toBe(true);
  });

  it("refuses a page that is not connected", async () => {
    const res = await routes.campaigns.POST(
      req(`${BASE}/campaigns`, "POST", { ...body, externalRef: `${REF}:x`, instagramUsername: "socksy.shopping" })
    );
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe("UNKNOWN_ACCOUNT");
  });
});
