import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    trackedLink: {
      findUnique: vi.fn(),
    },
    linkClick: {
      create: vi.fn(),
    },
    harveyEmail: {
      findFirst: vi.fn(),
    },
    outreachEvent: {
      create: vi.fn(),
    },
  },
}));

vi.mock("@/lib/db/client", () => ({
  prisma: mockPrisma,
}));

import { GET } from "../app/r/[slug]/route";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("tracked link redirect route", () => {
  it("fills the WhatsApp ref placeholder with the link's slug", async () => {
    mockPrisma.trackedLink.findUnique.mockResolvedValue({
      id: "link_wa",
      workspaceId: "workspace_123",
      automationId: "automation_123",
      destinationUrl:
        "https://wa.me/256700123456?text=Hi!%20I%20saw%20your%20post%20(ref%3A%20%7Bref%7D)",
      automation: { instagramAccountId: "ig_123" },
    });

    const response = await GET(
      new Request("https://app.test/r/aB3_x9Zk2q") as never,
      { params: Promise.resolve({ slug: "aB3_x9Zk2q" }) }
    );

    const location = response.headers.get("location") ?? "";
    expect(location).toContain("wa.me/256700123456");
    expect(decodeURIComponent(location)).toContain("(ref: aB3_x9Zk2q)");
    expect(location).not.toContain("%7Bref%7D");
  });

  it("logs a workspace-isolated click and redirects to the destination", async () => {
    mockPrisma.trackedLink.findUnique.mockResolvedValue({
      id: "link_123",
      workspaceId: "workspace_123",
      automationId: "automation_123",
      destinationUrl: "https://example.com/offer",
      automation: {
        instagramAccountId: "instagram_account_123",
      },
    });
    mockPrisma.linkClick.create.mockResolvedValue({});

    const response = await GET(
      new Request("https://manychat-alternative.com/r/abc123", {
        headers: {
          "user-agent": "vitest",
          referer: "https://instagram.com/",
          "x-forwarded-for": "203.0.113.10",
        },
      }) as Parameters<typeof GET>[0],
      { params: Promise.resolve({ slug: "abc123" }) }
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://example.com/offer");
    expect(mockPrisma.trackedLink.findUnique).toHaveBeenCalledWith({
      where: { slug: "abc123" },
      select: expect.any(Object),
    });
    expect(mockPrisma.linkClick.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: "workspace_123",
        automationId: "automation_123",
        instagramAccountId: "instagram_account_123",
        trackedLinkId: "link_123",
        userAgent: "vitest",
        referrer: "https://instagram.com/",
      }),
    });
  });

  it("redirects unknown slugs to the homepage without logging a click", async () => {
    mockPrisma.trackedLink.findUnique.mockResolvedValue(null);

    const response = await GET(
      new Request("https://manychat-alternative.com/r/missing") as Parameters<
        typeof GET
      >[0],
      { params: Promise.resolve({ slug: "missing" }) }
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://manychat-alternative.com/");
    expect(mockPrisma.linkClick.create).not.toHaveBeenCalled();
  });
});

describe("outbound links with no Instagram campaign behind them", () => {
  it("records the click with a null automation and account", async () => {
    mockPrisma.trackedLink.findUnique.mockResolvedValue({
      id: "link_harvey",
      workspaceId: "workspace_123",
      automationId: null,
      destinationUrl: "https://wa.me/256727214773?text=Wholesale%20(ref%3A%20%7Bref%7D)",
      automation: null,
    });
    mockPrisma.linkClick.create.mockResolvedValue({});

    const response = await GET(
      new Request("https://app.test/r/hv_9fQ2xs") as never,
      { params: Promise.resolve({ slug: "hv_9fQ2xs" }) }
    );

    expect(response.status).toBe(302);
    expect(mockPrisma.linkClick.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          workspaceId: "workspace_123",
          automationId: null,
          instagramAccountId: null,
          trackedLinkId: "link_harvey",
        }),
      })
    );
  });

  it("still resolves the WhatsApp ref, so the chat is attributed to the email", async () => {
    mockPrisma.trackedLink.findUnique.mockResolvedValue({
      id: "link_harvey",
      workspaceId: "workspace_123",
      automationId: null,
      destinationUrl: "https://wa.me/256727214773?text=Wholesale%20(ref%3A%20%7Bref%7D)",
      automation: null,
    });
    mockPrisma.linkClick.create.mockResolvedValue({});

    const response = await GET(
      new Request("https://app.test/r/hv_9fQ2xs") as never,
      { params: Promise.resolve({ slug: "hv_9fQ2xs" }) }
    );

    const location = response.headers.get("location") ?? "";
    expect(decodeURIComponent(location)).toContain("(ref: hv_9fQ2xs)");
    expect(location).not.toContain("%7Bref%7D");
  });
});

describe("telling the agent what happened", () => {
  it("records a click on an outbound link, with the email it belongs to", async () => {
    mockPrisma.trackedLink.findUnique.mockResolvedValue({
      id: "link_harvey",
      workspaceId: "workspace_123",
      automationId: null,
      source: "HARVEY_EMAIL",
      destinationUrl: "https://wa.me/256727214773?text=hi",
      automation: null,
    });
    mockPrisma.linkClick.create.mockResolvedValue({});
    mockPrisma.harveyEmail.findFirst.mockResolvedValue({
      harveyId: "o1",
      agentId: "agent_1",
      step: 2,
      prospect: { harveyId: "p1", email: "a@b.co" },
    });
    mockPrisma.outreachEvent.create.mockResolvedValue({});

    await GET(new Request("https://app.test/r/hv_9fQ2xs") as never, {
      params: Promise.resolve({ slug: "hv_9fQ2xs" }),
    });

    expect(mockPrisma.outreachEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: "LINK_CLICKED",
        agentId: "agent_1",
        emailHarveyId: "o1",
        prospectHarveyId: "p1",
        trackedLinkSlug: "hv_9fQ2xs",
      }),
    });
  });

  it("says nothing about a click on an Instagram campaign's link", async () => {
    mockPrisma.trackedLink.findUnique.mockResolvedValue({
      id: "link_ig",
      workspaceId: "workspace_123",
      automationId: "automation_123",
      source: "INSTAGRAM",
      destinationUrl: "https://example.com/offer",
      automation: { instagramAccountId: "ig_1" },
    });
    mockPrisma.linkClick.create.mockResolvedValue({});

    await GET(new Request("https://app.test/r/abc123") as never, {
      params: Promise.resolve({ slug: "abc123" }),
    });

    expect(mockPrisma.harveyEmail.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.outreachEvent.create).not.toHaveBeenCalled();
  });
});
