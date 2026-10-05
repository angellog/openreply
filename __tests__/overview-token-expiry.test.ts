import { beforeEach, describe, expect, it, vi } from "vitest";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    workspaceId: vi.fn(),
    account: vi.fn(),
    media: vi.fn(),
    opEvent: vi.fn(),
  },
}));

vi.mock("@/lib/auth", () => ({ getCurrentWorkspaceId: mocks.workspaceId }));
vi.mock("@/lib/instagram-accounts", () => ({
  getWorkspaceInstagramAccount: mocks.account,
}));
vi.mock("@/lib/meta/oauth", () => ({ decryptToken: () => "token" }));
vi.mock("@/lib/db/client", () => ({
  prisma: {
    operationalEvent: { create: mocks.opEvent },
    instagramAccount: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));
vi.mock("@/lib/meta/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/meta/client")>(
    "@/lib/meta/client"
  );
  return { ...actual, getAllUserMedia: mocks.media, getMediaInsights: vi.fn() };
});

import { NextRequest } from "next/server";
import { TokenExpiredError } from "@/lib/meta/client";
import { GET } from "../app/api/instagram/overview/route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.workspaceId.mockResolvedValue("ws_1");
  mocks.account.mockResolvedValue({
    id: "acc_1",
    username: "legitsneakers.ug",
    instagramId: "17841465636466450",
    accessToken: "encrypted",
  });
  mocks.opEvent.mockResolvedValue({});
});

function req() {
  // The route reads request.nextUrl, so this must be a NextRequest.
  return new NextRequest("https://app.test/api/instagram/overview");
}

describe("overview when Meta has invalidated the token", () => {
  it("names the account to reconnect instead of failing blank", async () => {
    mocks.media.mockRejectedValue(
      new TokenExpiredError("Error validating access token: session invalidated")
    );

    const res = await GET(req());
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.code).toBe("TOKEN_EXPIRED");
    expect(body.account).toBe("legitsneakers.ug");
    expect(body.error).toContain("legitsneakers.ug");
    expect(body.error).toMatch(/reconnect/i);
  });

  it("records it so the failure is visible outside the page", async () => {
    mocks.media.mockRejectedValue(new TokenExpiredError("invalidated"));
    await GET(req());

    expect(mocks.opEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          level: "ERROR",
          message: "Instagram session expired for @legitsneakers.ug",
        }),
      })
    );
  });

  it("still reports an unknown failure as a 500", async () => {
    mocks.media.mockRejectedValue(new Error("network went away"));

    const res = await GET(req());
    expect(res.status).toBe(500);
    expect((await res.json()).code).toBeUndefined();
  });
});
