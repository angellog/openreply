/**
 * The service API (/api/service/v1) KickShot Studio drives.
 *
 * Prisma is mocked here so this runs everywhere. The same flows run against a
 * real Postgres in service-api.db.test.ts when a local test database is given.
 */

import { createHash, randomBytes } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { db, sessionLookup } = vi.hoisted(() => ({
  db: {
    workspace: { findUnique: vi.fn() },
    instagramAccount: { findMany: vi.fn() },
    automation: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    trackedLink: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    dmLog: { groupBy: vi.fn() },
    linkClick: { groupBy: vi.fn() },
    whatsAppLead: { groupBy: vi.fn() },
    workspaceMember: { findFirst: vi.fn() },
    user: { findUnique: vi.fn() },
  },
  // What NextAuth's auth() would resolve from the session cookie.
  sessionLookup: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ prisma: db }));

// The real lib/auth.ts runs; only NextAuth itself is stubbed, so the dashboard
// test below exercises the genuine session-resolution path.
vi.mock("next-auth", () => ({
  default: () => ({
    handlers: {},
    auth: sessionLookup,
    signIn: vi.fn(),
    signOut: vi.fn(),
  }),
}));
vi.mock("next-auth/providers/nodemailer", () => ({ default: () => ({}) }));
vi.mock("next-auth/providers/resend", () => ({ default: () => ({}) }));
vi.mock("@auth/prisma-adapter", () => ({ PrismaAdapter: () => ({}) }));

import { NextRequest } from "next/server";
import {
  GET as listCampaigns,
  POST as createCampaign,
} from "../app/api/service/v1/campaigns/route";
import {
  GET as getCampaign,
  PATCH as patchCampaign,
} from "../app/api/service/v1/campaigns/[externalRef]/route";
import { GET as listAccounts } from "../app/api/service/v1/accounts/route";
import { GET as dashboardList } from "../app/api/automations/route";
import { resetServiceRateLimitMemory } from "@/lib/service/rate-limit";
import { serviceTokenMatches } from "@/lib/service/auth";

const TOKEN = randomBytes(32).toString("hex");
const TOKEN_SHA256 = createHash("sha256").update(TOKEN).digest("hex");
const WORKSPACE_ID = "ws_feetbit";
const BASE = "https://openreply.test/api/service/v1";
const REF = "kickshot:run42:feetbit.sneakers";

let ipCounter = 0;

function req(
  url: string,
  init: { method?: string; body?: unknown; token?: string | null; headers?: Record<string, string> } = {}
) {
  const headers: Record<string, string> = {
    // Each request gets its own IP so the rate limiter only bites where a test
    // wants it to.
    "x-forwarded-for": `10.0.${Math.floor(ipCounter / 250)}.${ipCounter++ % 250}`,
    ...init.headers,
  };
  const token = init.token === undefined ? TOKEN : init.token;
  if (token !== null) headers.authorization = `Bearer ${token}`;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  return new NextRequest(url, {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

const refContext = (ref: string) => ({ params: Promise.resolve({ externalRef: ref }) });

const ACCOUNT = {
  id: "acct_sneakers",
  instagramId: "17841400000000001",
  username: "feetbit.sneakers",
  accessToken: "encrypted",
  tokenExpiresAt: new Date("2027-01-20T00:00:00Z"),
  webhookSubscribed: true,
};

function campaignRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "auto_1",
    workspaceId: WORKSPACE_ID,
    instagramAccountId: ACCOUNT.id,
    externalRef: REF,
    name: "WALL reel",
    goal: null,
    postId: null,
    postUrl: null,
    pendingNextReel: false,
    matchAnyPost: false,
    keywords: ["WALL"],
    matchAnyWord: false,
    dmTriggerEnabled: false,
    dmMessage: "Here you go {username}",
    openingDmEnabled: false,
    openingDmMessage: null,
    openingDmButtonLabel: null,
    linkButtonLabel: "Shop",
    requireFollow: false,
    followPromptMessage: null,
    followPromptButtonLabel: null,
    followUpEnabled: false,
    followUpMessage: null,
    followUpDelayMinutes: 0,
    publicReplyEnabled: false,
    publicReplyMessage: null,
    publicReplyMessages: [],
    isActive: false,
    wholeWordMatch: true,
    reportShareSlug: "report_slug",
    reportShareEnabled: true,
    createdAt: new Date("2026-11-25T10:00:00Z"),
    updatedAt: new Date("2026-11-25T10:00:00Z"),
    instagramAccount: { username: ACCOUNT.username },
    trackedLinks: [
      { slug: "slugA", label: "Primary campaign link", destinationUrl: "https://feetbitsneakers.com/wall" },
    ],
    ...overrides,
  };
}

const validBody = {
  externalRef: REF,
  instagramUsername: "@FeetBit.Sneakers",
  name: "WALL reel",
  keywords: ["WALL"],
  dmMessage: "Here you go {username}",
  linkButtonLabel: "Shop",
  trackedDestinationUrl: "https://feetbitsneakers.com/wall",
};

beforeEach(() => {
  vi.clearAllMocks();
  resetServiceRateLimitMemory();
  vi.stubEnv("OPENREPLY_SERVICE_TOKEN_SHA256", TOKEN_SHA256);
  vi.stubEnv("OPENREPLY_SERVICE_WORKSPACE_ID", WORKSPACE_ID);
  vi.stubEnv("REDIS_URL", "");
  vi.stubEnv("NEXTAUTH_URL", "https://openreply.test");
  db.workspace.findUnique.mockResolvedValue({ id: WORKSPACE_ID });
  db.instagramAccount.findMany.mockResolvedValue([ACCOUNT]);
  db.automation.findUnique.mockResolvedValue(null);
  db.automation.findMany.mockResolvedValue([]);
  db.automation.create.mockResolvedValue({ id: "auto_1" });
  db.automation.update.mockResolvedValue({});
  db.trackedLink.findFirst.mockResolvedValue(null);
  db.trackedLink.findMany.mockResolvedValue([]);
  db.dmLog.groupBy.mockResolvedValue([]);
  db.linkClick.groupBy.mockResolvedValue([]);
  db.whatsAppLead.groupBy.mockResolvedValue([]);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ─── Auth ───────────────────────────────────────────────────────────────────

describe("service API auth", () => {
  it("answers 503 on every route when no token is configured", async () => {
    vi.stubEnv("OPENREPLY_SERVICE_TOKEN_SHA256", "");

    const responses = await Promise.all([
      listAccounts(req(`${BASE}/accounts`)),
      listCampaigns(req(`${BASE}/campaigns`)),
      createCampaign(req(`${BASE}/campaigns`, { method: "POST", body: validBody })),
      getCampaign(req(`${BASE}/campaigns/${REF}`), refContext(REF)),
      patchCampaign(
        req(`${BASE}/campaigns/${REF}`, { method: "PATCH", body: { isActive: false } }),
        refContext(REF)
      ),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({ error: "service API not configured" });
    }
    expect(db.automation.create).not.toHaveBeenCalled();
  });

  it("treats a missing workspace id or a malformed hash as not configured", async () => {
    vi.stubEnv("OPENREPLY_SERVICE_WORKSPACE_ID", "");
    expect((await listAccounts(req(`${BASE}/accounts`))).status).toBe(503);

    vi.stubEnv("OPENREPLY_SERVICE_WORKSPACE_ID", WORKSPACE_ID);
    vi.stubEnv("OPENREPLY_SERVICE_TOKEN_SHA256", "not-a-hash");
    expect((await listAccounts(req(`${BASE}/accounts`))).status).toBe(503);
  });

  it("refuses a wrong token with 401", async () => {
    const response = await listAccounts(req(`${BASE}/accounts`, { token: "nope".repeat(16) }));
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "invalid token" });
    expect(db.instagramAccount.findMany).not.toHaveBeenCalled();
  });

  it("refuses a request with no Authorization header with 401", async () => {
    const response = await listAccounts(req(`${BASE}/accounts`, { token: null }));
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toMatch(/^Bearer/);
  });

  it("never accepts a dashboard session cookie", async () => {
    // A logged-in browser: a valid session exists, but no bearer token.
    sessionLookup.mockResolvedValue({ user: { id: "user_angelo" } });

    const response = await createCampaign(
      req(`${BASE}/campaigns`, {
        method: "POST",
        body: validBody,
        token: null,
        headers: { cookie: "__Secure-authjs.session-token=valid-session" },
      })
    );

    expect(response.status).toBe(401);
    expect(sessionLookup).not.toHaveBeenCalled();
    expect(db.automation.create).not.toHaveBeenCalled();
  });

  it("accepts the right token in constant-time comparison", async () => {
    expect(serviceTokenMatches(TOKEN, Buffer.from(TOKEN_SHA256, "hex"))).toBe(true);
    expect(serviceTokenMatches(`${TOKEN}x`, Buffer.from(TOKEN_SHA256, "hex"))).toBe(false);
    expect((await listAccounts(req(`${BASE}/accounts`))).status).toBe(200);
  });

  it("rate-limits a caller with 429 and Retry-After", async () => {
    vi.stubEnv("OPENREPLY_SERVICE_RATE_LIMIT_PER_MINUTE", "3");
    const sameIp = { "x-forwarded-for": "203.0.113.9" };

    for (let i = 0; i < 3; i++) {
      expect((await listAccounts(req(`${BASE}/accounts`, { headers: sameIp }))).status).toBe(200);
    }
    const limited = await listAccounts(req(`${BASE}/accounts`, { headers: sameIp }));
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    // Token guessing is throttled too: the limit applies before the token check.
    const guessing = await listAccounts(req(`${BASE}/accounts`, { headers: sameIp, token: "guess" }));
    expect(guessing.status).toBe(429);
  });

  it("does not let the token act on the dashboard routes", async () => {
    // No session cookie, only the service token.
    sessionLookup.mockResolvedValue(null);

    const response = await dashboardList(
      req("https://openreply.test/api/automations") as NextRequest
    );

    expect(response.status).toBe(401);
    expect(db.automation.findMany).not.toHaveBeenCalled();
  });

  it("keeps the two auth paths in separate code", () => {
    const root = path.resolve(__dirname, "..");
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const full = path.join(dir, name);
        return statSync(full).isDirectory() ? walk(full) : full.endsWith(".ts") ? [full] : [];
      });

    const serviceRoutes = walk(path.join(root, "app/api/service"));
    expect(serviceRoutes.length).toBe(3);
    for (const file of serviceRoutes) {
      const source = readFileSync(file, "utf8");
      expect(source, file).toContain("authenticateServiceRequest");
      expect(source, file).not.toMatch(/@\/lib\/auth"|@\/lib\/workspace-access"|next\/headers/);
    }

    const otherRoutes = walk(path.join(root, "app/api")).filter(
      (file) => !file.includes(`${path.sep}service${path.sep}`)
    );
    for (const file of otherRoutes) {
      expect(readFileSync(file, "utf8"), file).not.toContain("@/lib/service/auth");
    }
  });
});

// ─── Accounts ───────────────────────────────────────────────────────────────

describe("GET /accounts", () => {
  it("lists every account with whether it can send", async () => {
    db.instagramAccount.findMany.mockResolvedValue([
      ACCOUNT,
      { ...ACCOUNT, id: "acct_group", instagramId: "2", username: "feetbitgroup", webhookSubscribed: false },
      {
        ...ACCOUNT,
        id: "acct_socksy",
        instagramId: "3",
        username: "socksy.shopping",
        tokenExpiresAt: new Date("2026-01-01T00:00:00Z"),
      },
    ]);

    const response = await listAccounts(req(`${BASE}/accounts`));
    const { accounts } = await response.json();

    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(accounts).toEqual([
      expect.objectContaining({
        id: "acct_sneakers",
        username: "feetbit.sneakers",
        connected: true,
        tokenExpiresAt: "2027-01-20T00:00:00.000Z",
        canPrivateReply: true,
        privateReplyLimitPerHour: 750,
      }),
      // Connected, but Meta is not delivering its comments: cannot reply.
      expect.objectContaining({ username: "feetbitgroup", connected: true, canPrivateReply: false }),
      // Expired token.
      expect.objectContaining({ username: "socksy.shopping", connected: false, canPrivateReply: false }),
    ]);
    expect(db.instagramAccount.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId: WORKSPACE_ID } })
    );
  });
});

// ─── Create ─────────────────────────────────────────────────────────────────

describe("POST /campaigns", () => {
  it("creates a new campaign, inactive and postless, with tracked link and report slug (201)", async () => {
    db.automation.findUnique
      .mockResolvedValueOnce(null) // the idempotency lookup
      .mockResolvedValue(campaignRow()); // the read-back

    const response = await createCampaign(req(`${BASE}/campaigns`, { method: "POST", body: validBody }));

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.created).toBe(true);
    expect(body.campaign).toMatchObject({
      externalRef: REF,
      instagramUsername: "feetbit.sneakers",
      isActive: false,
      postId: null,
      trackedUrl: "https://openreply.test/r/slugA",
      reportUrl: "https://openreply.test/reports/report_slug",
      stats: { dmsSent: 0, dmsSkipped: 0, dmsFailed: 0, linkClicks: 0, ctr: 0, whatsappLeads: 0, lastDmAt: null },
    });

    const data = db.automation.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      workspaceId: WORKSPACE_ID,
      instagramAccountId: ACCOUNT.id,
      externalRef: REF,
      isActive: false,
      postId: null,
      matchAnyPost: false,
      pendingNextReel: false,
      matchAnyWord: false,
      keywords: ["WALL"],
      linkButtonLabel: "Shop",
    });
    expect(data.reportShareSlug).toEqual(expect.any(String));
    expect(data.trackedLinks.create).toEqual([
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        label: "Primary campaign link",
        destinationUrl: "https://feetbitsneakers.com/wall",
        slug: expect.any(String),
      }),
    ]);
  });

  it("returns the existing campaign for a repeated externalRef (200) and never creates a duplicate", async () => {
    db.automation.findUnique.mockResolvedValue(campaignRow());

    const response = await createCampaign(
      req(`${BASE}/campaigns`, {
        method: "POST",
        body: { ...validBody, dmMessage: "Updated DM", keywords: ["WALL", "PRICE"] },
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ created: false, campaign: { externalRef: REF } });
    expect(db.automation.create).not.toHaveBeenCalled();
    expect(db.automation.update).toHaveBeenCalledWith({
      where: { id: "auto_1" },
      data: expect.objectContaining({
        dmMessage: "Updated DM",
        keywords: ["WALL", "PRICE"],
        name: "WALL reel",
      }),
    });
    // isActive was not sent, so a re-POST must not switch a live campaign off.
    expect(db.automation.update.mock.calls[0][0].data).not.toHaveProperty("isActive");
  });

  it("survives two concurrent creates of the same ref: the loser updates the winner", async () => {
    db.automation.findUnique
      .mockResolvedValueOnce(null) // no campaign yet…
      .mockResolvedValue(campaignRow()); // …but the other request created it
    db.automation.create.mockRejectedValue(Object.assign(new Error("Unique constraint"), { code: "P2002" }));

    const response = await createCampaign(req(`${BASE}/campaigns`, { method: "POST", body: validBody }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ created: false });
    expect(db.automation.update).toHaveBeenCalled();
  });

  it("refuses an externalRef already used on another page (409)", async () => {
    db.automation.findUnique.mockResolvedValue(campaignRow());

    const response = await createCampaign(
      req(`${BASE}/campaigns`, { method: "POST", body: { ...validBody, instagramUsername: "flashkidstore" } })
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "EXTERNAL_REF_CONFLICT" });
    expect(db.automation.update).not.toHaveBeenCalled();
  });

  it("refuses an unknown Instagram username with 422 and lists what is connected", async () => {
    const response = await createCampaign(
      req(`${BASE}/campaigns`, { method: "POST", body: { ...validBody, instagramUsername: "legitsneakers.ug" } })
    );

    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body.code).toBe("UNKNOWN_ACCOUNT");
    expect(body.error).toContain("@legitsneakers.ug");
    expect(body.error).toContain("@feetbit.sneakers");
    expect(db.automation.create).not.toHaveBeenCalled();
  });

  it("refuses an account whose token has expired with 422", async () => {
    db.instagramAccount.findMany.mockResolvedValue([
      { ...ACCOUNT, tokenExpiresAt: new Date("2026-01-01T00:00:00Z") },
    ]);

    const response = await createCampaign(req(`${BASE}/campaigns`, { method: "POST", body: validBody }));

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ code: "ACCOUNT_NOT_CONNECTED" });
  });

  it("refuses isActive: true without a post (422)", async () => {
    const response = await createCampaign(
      req(`${BASE}/campaigns`, { method: "POST", body: { ...validBody, isActive: true } })
    );
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ code: "POST_REQUIRED" });
    expect(db.automation.create).not.toHaveBeenCalled();
  });

  it.each([
    ["missing externalRef", { ...validBody, externalRef: undefined }, "externalRef"],
    ["externalRef over 120 chars", { ...validBody, externalRef: `kickshot:${"x".repeat(120)}` }, "externalRef"],
    ["externalRef with a slash", { ...validBody, externalRef: "kickshot/run/page" }, "externalRef"],
    ["no keywords", { ...validBody, keywords: [] }, "keywords"],
    ["empty DM", { ...validBody, dmMessage: "" }, "dmMessage"],
    ["bad destination URL", { ...validBody, trackedDestinationUrl: "feetbitsneakers" }, "trackedDestinationUrl"],
    ["follow-up delay past 24h", { ...validBody, followUpDelayMinutes: 2000 }, "followUpDelayMinutes"],
    ["button label over 20 chars", { ...validBody, linkButtonLabel: "x".repeat(21) }, "linkButtonLabel"],
    ["a sign-in-code keyword", { ...validBody, keywords: ["FeetBit code"] }, "keywords.0"],
  ])("rejects %s with 400 and the offending path", async (_label, body, issuePath) => {
    const response = await createCampaign(req(`${BASE}/campaigns`, { method: "POST", body }));
    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.code).toBe("INVALID_INPUT");
    expect(json.issues.map((i: { path: string }) => i.path)).toContain(issuePath);
    expect(db.automation.create).not.toHaveBeenCalled();
  });

  it("rejects a body that is not JSON", async () => {
    const response = await createCampaign(
      new NextRequest(`${BASE}/campaigns`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "x-forwarded-for": "198.51.100.1" },
        body: "{nope",
      })
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "INVALID_JSON" });
  });
});

// ─── Attach / pause / edit ──────────────────────────────────────────────────

describe("PATCH /campaigns/:externalRef", () => {
  it("attaches the published reel and switches the campaign on", async () => {
    db.automation.findUnique.mockResolvedValue(campaignRow());

    const response = await patchCampaign(
      req(`${BASE}/campaigns/${REF}`, {
        method: "PATCH",
        body: { postId: "17900000000000001", postUrl: "https://www.instagram.com/reel/abc/" },
      }),
      refContext(REF)
    );

    expect(response.status).toBe(200);
    expect(db.automation.update).toHaveBeenCalledWith({
      where: { id: "auto_1" },
      data: {
        postId: "17900000000000001",
        postUrl: "https://www.instagram.com/reel/abc/",
        isActive: true,
      },
    });
  });

  it("accepts an URL-encoded ref in the path", async () => {
    db.automation.findUnique.mockResolvedValue(campaignRow());
    const encoded = encodeURIComponent(REF);
    const response = await getCampaign(req(`${BASE}/campaigns/${encoded}`), refContext(encoded));
    expect(response.status).toBe(200);
    expect(db.automation.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId_externalRef: { workspaceId: WORKSPACE_ID, externalRef: REF } },
      })
    );
  });

  it("can attach without activating when isActive: false is sent", async () => {
    db.automation.findUnique.mockResolvedValue(campaignRow());
    await patchCampaign(
      req(`${BASE}/campaigns/${REF}`, { method: "PATCH", body: { postId: "179", isActive: false } }),
      refContext(REF)
    );
    expect(db.automation.update.mock.calls[0][0].data).toMatchObject({ postId: "179", isActive: false });
  });

  it("pauses and resumes", async () => {
    db.automation.findUnique.mockResolvedValue(campaignRow({ postId: "179", isActive: true }));

    await patchCampaign(
      req(`${BASE}/campaigns/${REF}`, { method: "PATCH", body: { isActive: false } }),
      refContext(REF)
    );
    expect(db.automation.update.mock.calls[0][0].data).toEqual({ isActive: false });

    await patchCampaign(
      req(`${BASE}/campaigns/${REF}`, { method: "PATCH", body: { isActive: true } }),
      refContext(REF)
    );
    expect(db.automation.update.mock.calls[1][0].data).toEqual({ isActive: true });
  });

  it("refuses to resume a campaign that has no post (422)", async () => {
    db.automation.findUnique.mockResolvedValue(campaignRow());
    const response = await patchCampaign(
      req(`${BASE}/campaigns/${REF}`, { method: "PATCH", body: { isActive: true } }),
      refContext(REF)
    );
    expect(response.status).toBe(422);
    expect(db.automation.update).not.toHaveBeenCalled();
  });

  it("edits message fields and moves the tracked link without changing its slug", async () => {
    db.automation.findUnique.mockResolvedValue(campaignRow({ postId: "179", isActive: true }));
    db.trackedLink.findFirst.mockResolvedValue({ id: "link_1", slug: "slugA" });

    await patchCampaign(
      req(`${BASE}/campaigns/${REF}`, {
        method: "PATCH",
        body: {
          dmMessage: "New copy",
          followUpEnabled: false,
          trackedDestinationUrl: "https://feetbitsneakers.com/wall-v2",
        },
      }),
      refContext(REF)
    );

    expect(db.automation.update.mock.calls[0][0].data).toEqual({
      dmMessage: "New copy",
      followUpEnabled: false,
      // Shared normalisation: a disabled follow-up clears its text and delay.
      followUpMessage: null,
      followUpDelayMinutes: 0,
    });
    expect(db.trackedLink.update).toHaveBeenCalledWith({
      where: { id: "link_1" },
      data: { destinationUrl: "https://feetbitsneakers.com/wall-v2" },
    });
    expect(db.trackedLink.create).not.toHaveBeenCalled();
  });

  it("answers 404 for an unknown ref and 400 for an invalid one", async () => {
    const missing = await patchCampaign(
      req(`${BASE}/campaigns/kickshot:none`, { method: "PATCH", body: { isActive: false } }),
      refContext("kickshot:none")
    );
    expect(missing.status).toBe(404);

    const invalid = await getCampaign(req(`${BASE}/campaigns/x`), refContext("has space"));
    expect(invalid.status).toBe(400);
  });

  it("validates the body", async () => {
    db.automation.findUnique.mockResolvedValue(campaignRow());
    const response = await patchCampaign(
      req(`${BASE}/campaigns/${REF}`, { method: "PATCH", body: { keywords: [], isActive: "yes" } }),
      refContext(REF)
    );
    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.issues.map((i: { path: string }) => i.path)).toEqual(
      expect.arrayContaining(["keywords", "isActive"])
    );
  });
});

// ─── Stats and list ─────────────────────────────────────────────────────────

describe("stats", () => {
  function mockActivity() {
    db.dmLog.groupBy.mockImplementation(async (args: { by: string[]; _max?: unknown }) => {
      if (args._max) {
        return [{ automationId: "auto_1", _max: { dmSentAt: new Date("2026-11-25T12:30:00Z") } }];
      }
      if (args.by.includes("status")) {
        return [
          { automationId: "auto_1", status: "SENT", _count: { _all: 40 } },
          { automationId: "auto_1", status: "SKIPPED_DEDUP", _count: { _all: 3 } },
          { automationId: "auto_1", status: "SKIPPED_RATE_LIMIT", _count: { _all: 2 } },
          { automationId: "auto_1", status: "FAILED", _count: { _all: 1 } },
          { automationId: "auto_2", status: "SENT", _count: { _all: 5 } },
        ];
      }
      return [];
    });
    db.linkClick.groupBy.mockResolvedValue([
      { automationId: "auto_1", _count: { _all: 10 } },
      { automationId: null, _count: { _all: 99 } },
    ]);
    db.whatsAppLead.groupBy.mockResolvedValue([{ automationId: "auto_1", _count: { _all: 4 } }]);
  }

  it("GET /campaigns/:ref reports sends, skips, failures, clicks, CTR, leads and last DM", async () => {
    mockActivity();
    db.automation.findUnique.mockResolvedValue(campaignRow({ postId: "179", isActive: true }));

    const response = await getCampaign(req(`${BASE}/campaigns/${REF}`), refContext(REF));

    expect(response.status).toBe(200);
    const { campaign } = await response.json();
    expect(campaign.stats).toEqual({
      dmsSent: 40,
      dmsSkipped: 5,
      dmsFailed: 1,
      linkClicks: 10,
      ctr: 25,
      whatsappLeads: 4,
      lastDmAt: "2026-11-25T12:30:00.000Z",
    });
    // Stats are scoped to this campaign in this workspace.
    expect(db.dmLog.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ workspaceId: WORKSPACE_ID, automationId: { in: ["auto_1"] } }),
      })
    );
  });

  it("GET /campaigns?prefix= lists only service campaigns under that prefix, with stats", async () => {
    mockActivity();
    db.automation.findMany.mockResolvedValue([
      campaignRow(),
      campaignRow({ id: "auto_2", externalRef: "kickshot:run42:feetbitgroup", instagramAccount: { username: "feetbitgroup" } }),
    ]);

    const response = await listCampaigns(req(`${BASE}/campaigns?prefix=kickshot:`));

    expect(response.status).toBe(200);
    const { campaigns } = await response.json();
    expect(campaigns.map((c: { externalRef: string }) => c.externalRef)).toEqual([
      REF,
      "kickshot:run42:feetbitgroup",
    ]);
    expect(campaigns[0].stats.dmsSent).toBe(40);
    expect(campaigns[1].stats).toMatchObject({ dmsSent: 5, linkClicks: 0, whatsappLeads: 0, lastDmAt: null });
    expect(db.automation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId: WORKSPACE_ID, externalRef: { startsWith: "kickshot:" } },
        take: 100,
      })
    );
  });

  it("without a prefix lists every campaign that has a ref, never dashboard-built ones", async () => {
    await listCampaigns(req(`${BASE}/campaigns`));
    expect(db.automation.findMany.mock.calls[0][0].where).toEqual({
      workspaceId: WORKSPACE_ID,
      externalRef: { not: null },
    });
  });

  it("filters by page and validates limit", async () => {
    await listCampaigns(req(`${BASE}/campaigns?prefix=kickshot:&instagramUsername=@FeetBitGroup&limit=5`));
    expect(db.automation.findMany.mock.calls[0][0]).toMatchObject({
      where: {
        instagramAccount: { username: { equals: "feetbitgroup", mode: "insensitive" } },
      },
      take: 5,
    });

    expect((await listCampaigns(req(`${BASE}/campaigns?limit=0`))).status).toBe(400);
    expect((await listCampaigns(req(`${BASE}/campaigns?limit=501`))).status).toBe(400);
  });
});
