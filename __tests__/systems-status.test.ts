import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    instagramAccount: { findMany: vi.fn() },
    automation: { count: vi.fn() },
    dmLog: { count: vi.fn() },
    whatsAppLead: { count: vi.fn() },
    harveyAgent: { findMany: vi.fn() },
    harveyEmail: { count: vi.fn() },
    outreachEvent: { count: vi.fn() },
    workspace: { findUnique: vi.fn() },
    resource: { count: vi.fn() },
    resourceLead: { count: vi.fn() },
    workspaceMember: { count: vi.fn() },
    operationalEvent: { count: vi.fn() },
    isEmailConfigured: vi.fn(),
  },
}));

vi.mock("@/lib/db/client", () => ({
  prisma: {
    instagramAccount: mocks.instagramAccount,
    automation: mocks.automation,
    dmLog: mocks.dmLog,
    whatsAppLead: mocks.whatsAppLead,
    harveyAgent: mocks.harveyAgent,
    harveyEmail: mocks.harveyEmail,
    outreachEvent: mocks.outreachEvent,
    workspace: mocks.workspace,
    resource: mocks.resource,
    resourceLead: mocks.resourceLead,
    workspaceMember: mocks.workspaceMember,
    operationalEvent: mocks.operationalEvent,
  },
}));
vi.mock("@/lib/email/send", () => ({
  isEmailConfigured: mocks.isEmailConfigured,
}));

import { readSystemStatuses, worstState } from "@/lib/systems/status";
import { SYSTEMS, type SystemId } from "@/lib/systems/registry";
import { EXPORTABLE_LEAD_WHERE } from "@/lib/harvey/sync";
import type { SystemState, SystemStatus } from "@/lib/systems/status";

const ENV_KEYS = [
  ...SYSTEMS.instagram.requiredEnv,
  ...SYSTEMS.whatsapp.requiredEnv,
  ...SYSTEMS.platform.requiredEnv,
];

const saved = new Map<string, string | undefined>();

function statusFor(statuses: SystemStatus[], id: SystemId): SystemStatus {
  const found = statuses.find((status) => status.id === id);
  if (!found) throw new Error(`no status for ${id}`);
  return found;
}

/** The happy path for every system, so each test can break one thing. */
function healthy() {
  mocks.instagramAccount.findMany.mockResolvedValue([
    {
      username: "feetbit",
      tokenExpiresAt: new Date(Date.now() + 30 * 86_400_000),
      webhookSubscribed: true,
    },
  ]);
  mocks.automation.count.mockResolvedValue(3);
  mocks.dmLog.count.mockResolvedValue(12);
  mocks.whatsAppLead.count.mockResolvedValue(4);
  mocks.harveyAgent.findMany.mockResolvedValue([
    {
      name: "feetbit-contracts",
      status: "ACTIVE",
      lastSeenAt: new Date(Date.now() - 60_000),
      whatsappPhone: "+256700000000",
      defaultDestinationUrl: null,
    },
  ]);
  mocks.harveyEmail.count.mockResolvedValue(0);
  mocks.outreachEvent.count.mockResolvedValue(2);
  mocks.workspace.findUnique.mockResolvedValue({ publicSlug: "vantik" });
  mocks.resource.count.mockResolvedValue(2);
  mocks.resourceLead.count.mockResolvedValue(0);
  mocks.workspaceMember.count.mockResolvedValue(1);
  mocks.operationalEvent.count.mockResolvedValue(0);
  mocks.isEmailConfigured.mockReturnValue(true);
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of ENV_KEYS) {
    saved.set(key, process.env[key]);
    process.env[key] = "set-for-test";
  }
  healthy();
});

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  saved.clear();
});

describe("readSystemStatuses", () => {
  it("returns one status per system, in registry order", async () => {
    const statuses = await readSystemStatuses("ws_1");
    expect(statuses.map((s) => s.id)).toEqual([
      "instagram",
      "whatsapp",
      "harvey",
      "resources",
      "platform",
    ]);
  });

  it("reports a missing variable by name and never its value", async () => {
    delete process.env.OPENWA_API_KEY;

    const whatsapp = statusFor(await readSystemStatuses("ws_1"), "whatsapp");

    expect(whatsapp.state).toBe("setup");
    expect(whatsapp.missingEnv).toEqual(["OPENWA_API_KEY"]);
    expect(whatsapp.summary).toContain("OPENWA_API_KEY");
    expect(whatsapp.summary).not.toContain("set-for-test");
  });

  it("does not query the database for a system that cannot run", async () => {
    delete process.env.OPENWA_BASE_URL;

    await readSystemStatuses("ws_1");

    expect(mocks.whatsAppLead.count).not.toHaveBeenCalled();
  });

  // A status page that 500s because one count failed is worse than no status
  // page, so one broken probe must not take the other four with it.
  it("isolates a probe that throws", async () => {
    mocks.harveyAgent.findMany.mockRejectedValue(new Error("connection lost"));

    const statuses = await readSystemStatuses("ws_1");

    expect(statusFor(statuses, "harvey").state).toBe("unknown");
    expect(statusFor(statuses, "harvey").summary).toContain("connection lost");
    expect(statusFor(statuses, "instagram").state).toBe("live");
    expect(statusFor(statuses, "platform").state).toBe("live");
  });
});

describe("Instagram status", () => {
  it("is live when a campaign is on and DMs went out", async () => {
    const status = statusFor(await readSystemStatuses("ws_1"), "instagram");
    expect(status.state).toBe("live");
    expect(status.metrics).toContainEqual({
      label: "DMs sent (7d)",
      value: "12",
    });
  });

  it("asks for an account before anything else", async () => {
    mocks.instagramAccount.findMany.mockResolvedValue([]);
    const status = statusFor(await readSystemStatuses("ws_1"), "instagram");
    expect(status.state).toBe("setup");
    expect(status.nextStep?.href).toBe("/overview");
  });

  it("names the account whose token expired", async () => {
    mocks.instagramAccount.findMany.mockResolvedValue([
      {
        username: "feetbit",
        tokenExpiresAt: new Date(Date.now() - 1000),
        webhookSubscribed: true,
      },
    ]);
    const status = statusFor(await readSystemStatuses("ws_1"), "instagram");
    expect(status.state).toBe("attention");
    expect(status.summary).toContain("@feetbit");
  });

  // A connected account with no webhook subscription sends nothing and looks
  // perfectly healthy otherwise, which is the worst kind of broken.
  it("flags an account that is not subscribed to webhooks", async () => {
    mocks.instagramAccount.findMany.mockResolvedValue([
      {
        username: "feetbit",
        tokenExpiresAt: new Date(Date.now() + 86_400_000),
        webhookSubscribed: false,
      },
    ]);
    const status = statusFor(await readSystemStatuses("ws_1"), "instagram");
    expect(status.state).toBe("attention");
    expect(status.summary).toContain("webhook");
  });

  it("separates having no campaign from having none switched on", async () => {
    mocks.automation.count.mockImplementation(
      ({ where }: { where: { isActive?: boolean } }) =>
        Promise.resolve(where.isActive ? 0 : 4)
    );
    const status = statusFor(await readSystemStatuses("ws_1"), "instagram");
    expect(status.state).toBe("attention");
    expect(status.summary).toContain("none is switched on");

    mocks.automation.count.mockResolvedValue(0);
    const empty = statusFor(await readSystemStatuses("ws_1"), "instagram");
    expect(empty.state).toBe("setup");
    expect(empty.nextStep?.href).toBe("/campaigns/new");
  });

  it("is idle, not broken, when nothing has matched lately", async () => {
    mocks.dmLog.count.mockResolvedValue(0);
    const status = statusFor(await readSystemStatuses("ws_1"), "instagram");
    expect(status.state).toBe("idle");
  });
});

describe("Harvey status", () => {
  it("is live when it checked in and did something", async () => {
    const status = statusFor(await readSystemStatuses("ws_1"), "harvey");
    expect(status.state).toBe("live");
  });

  it("asks for an agent when none is paired", async () => {
    mocks.harveyAgent.findMany.mockResolvedValue([]);
    const status = statusFor(await readSystemStatuses("ws_1"), "harvey");
    expect(status.state).toBe("setup");
    expect(status.nextStep?.href).toBe("/outreach");
  });

  it("calls out an agent that exists but has never checked in", async () => {
    mocks.harveyAgent.findMany.mockResolvedValue([
      {
        name: "vantik",
        status: "ACTIVE",
        lastSeenAt: null,
        whatsappPhone: null,
        defaultDestinationUrl: "https://cal.com/vantik",
      },
    ]);
    const status = statusFor(await readSystemStatuses("ws_1"), "harvey");
    expect(status.state).toBe("setup");
    expect(status.summary).toContain(".env");
  });

  // Ranked above pending approvals on purpose: approving an email from an
  // agent with no handoff sends a dead end to a real person.
  it("puts a missing handoff ahead of waiting approvals", async () => {
    mocks.harveyAgent.findMany.mockResolvedValue([
      {
        name: "feetbit-contracts",
        status: "ACTIVE",
        lastSeenAt: new Date(),
        whatsappPhone: null,
        defaultDestinationUrl: null,
      },
    ]);
    mocks.harveyEmail.count.mockResolvedValue(7);

    const status = statusFor(await readSystemStatuses("ws_1"), "harvey");

    expect(status.state).toBe("attention");
    expect(status.summary).toContain("no handoff");
    expect(status.summary).not.toContain("waiting for your");
    expect(status.nextStep?.label).toBe("Set the handoff");
  });

  it("surfaces waiting approvals once the handoff is set", async () => {
    mocks.harveyEmail.count.mockResolvedValue(7);
    const status = statusFor(await readSystemStatuses("ws_1"), "harvey");
    expect(status.state).toBe("attention");
    expect(status.summary).toContain("7 emails");
  });

  it("says how long ago a sleeping Mac last spoke", async () => {
    mocks.harveyAgent.findMany.mockResolvedValue([
      {
        name: "feetbit-contracts",
        status: "ACTIVE",
        lastSeenAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
        whatsappPhone: "+256700000000",
        defaultDestinationUrl: null,
      },
    ]);
    const status = statusFor(await readSystemStatuses("ws_1"), "harvey");
    expect(status.state).toBe("attention");
    expect(status.summary).toContain("3 hours");
  });

  it("treats an all-revoked workspace as broken, not unpaired", async () => {
    mocks.harveyAgent.findMany.mockResolvedValue([
      {
        name: "old",
        status: "REVOKED",
        lastSeenAt: new Date(),
        whatsappPhone: "+256700000000",
        defaultDestinationUrl: null,
      },
    ]);
    const status = statusFor(await readSystemStatuses("ws_1"), "harvey");
    expect(status.state).toBe("attention");
    expect(status.summary).toContain("revoked");
  });
});

describe("Resource hub status", () => {
  it("blocks on mail before anything else", async () => {
    mocks.isEmailConfigured.mockReturnValue(false);
    const status = statusFor(await readSystemStatuses("ws_1"), "resources");
    expect(status.state).toBe("setup");
    expect(status.summary).toContain("EMAIL_SERVER");
    expect(status.summary).toContain("RESEND_API_KEY");
  });

  it("asks for a public slug before asking for resources", async () => {
    mocks.workspace.findUnique.mockResolvedValue({ publicSlug: null });
    const status = statusFor(await readSystemStatuses("ws_1"), "resources");
    expect(status.state).toBe("setup");
    expect(status.nextStep?.href).toBe("/outreach/resources");
  });

  it("separates written from published", async () => {
    mocks.resource.count.mockImplementation(
      ({ where }: { where: { isPublished?: boolean } }) =>
        Promise.resolve(where.isPublished ? 0 : 3)
    );
    const status = statusFor(await readSystemStatuses("ws_1"), "resources");
    expect(status.state).toBe("attention");
    expect(status.summary).toContain("none published");
  });

  // The map said "Ready for Harvey" using its own spelling of the rule —
  // consented and not yet exported — which counted leads whose delivery email
  // bounced. The sync refuses those, so the number promised Harvey leads it
  // would never be handed. Both now read EXPORTABLE_LEAD_WHERE.
  it("counts leads Harvey would actually be given, delivery included", async () => {
    await readSystemStatuses("ws_1");

    const calls = (mocks.resourceLead.count.mock.calls as unknown[][]).map(
      (call) => (call[0] as { where: Record<string, unknown> }).where
    );
    const readyCall = calls.find((where) => where.consentMarketing === true);

    expect(readyCall).toMatchObject(EXPORTABLE_LEAD_WHERE);
    expect(readyCall?.deliveryStatus).toBe("SENT");
  });

  it("links to the live public hub when it is quiet", async () => {
    const status = statusFor(await readSystemStatuses("ws_1"), "resources");
    expect(status.state).toBe("idle");
    expect(status.nextStep?.href).toBe("/resources/vantik");
  });
});

describe("Platform status", () => {
  it("raises unresolved errors", async () => {
    mocks.operationalEvent.count.mockResolvedValue(2);
    const status = statusFor(await readSystemStatuses("ws_1"), "platform");
    expect(status.state).toBe("attention");
    expect(status.nextStep?.href).toBe("/diagnostics");
  });
});

describe("worstState", () => {
  const status = (state: SystemState): SystemStatus => ({
    id: "harvey",
    state,
    summary: "",
    metrics: [],
    nextStep: null,
    missingEnv: [],
  });

  it("puts what needs a human first", () => {
    expect(worstState([status("live"), status("attention"), status("setup")])).toBe(
      "attention"
    );
  });

  it("prefers an unreadable probe over an unconfigured system", () => {
    expect(worstState([status("setup"), status("unknown")])).toBe("unknown");
  });

  it("reports live only when everything is live", () => {
    expect(worstState([status("live"), status("live")])).toBe("live");
    expect(worstState([status("live"), status("idle")])).toBe("idle");
  });

  it("calls an empty list live rather than throwing", () => {
    expect(worstState([])).toBe("live");
  });
});
