/**
 * The FeetBit store's sign-in flow ("FeetBit code 123456") shares the OpenWA
 * session OpenReply replies from. No campaign may ever auto-answer it.
 * The Instagram worker side is covered in dm-worker.test.ts.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { db, provider } = vi.hoisted(() => ({
  db: {
    trackedLink: { findUnique: vi.fn() },
    whatsAppLead: { findFirst: vi.fn(), upsert: vi.fn(), update: vi.fn() },
    whatsAppMessage: { create: vi.fn(), count: vi.fn() },
    operationalEvent: { create: vi.fn() },
  },
  provider: { sendText: vi.fn() },
}));

vi.mock("@/lib/db/client", () => ({ prisma: db }));
vi.mock("@/lib/whatsapp/provider", () => ({
  getWhatsAppProvider: () => provider,
  WhatsAppProviderError: class extends Error {},
}));
vi.mock("@/lib/outreach/events", () => ({
  findHarveyEmailForTrackedLink: vi.fn(),
  recordOutreachEvent: vi.fn(),
}));

import { isSignInCodeKeyword, isSignInCodeMessage } from "@/lib/safety/sign-in-codes";
import { handleInboundWhatsAppMessage } from "@/lib/whatsapp/inbound";
import { createAutomationSchema } from "@/lib/automations/campaign";

describe("isSignInCodeMessage", () => {
  it.each([
    "FeetBit code: 482913",
    "Your FeetBit code is 482913",
    "feetbit code",
    "FEETBIT CODE 482913",
    "Feet Bit code 482913",
    "feetbit-code 482913",
    "FeetBit verification code 482913",
    "Your FeetBit sign-in code: 482913",
    "FeetBit login code 482913",
    "FeetBit one-time code 482913",
    "FeetBit\u200Bcode 482913",
    "Hi! (ref: abc1234) FeetBit code 482913",
    "FeetBit: code 482913",
  ])("matches %j", (text) => {
    expect(isSignInCodeMessage(text)).toBe(true);
  });

  it.each([
    "",
    null,
    undefined,
    "Hi! I want these (ref: abc1234)",
    "do you have a discount code?",
    "FeetBit sneakers size 43",
    "Is the promo code still valid at FeetBit?",
  ])("leaves %j alone", (text) => {
    expect(isSignInCodeMessage(text)).toBe(false);
  });

  it("refuses the phrase as a campaign keyword, in the dashboard schema too", () => {
    expect(isSignInCodeKeyword("FeetBit code")).toBe(true);
    expect(isSignInCodeKeyword("WALL")).toBe(false);

    const parsed = createAutomationSchema.safeParse({
      name: "Bad",
      dmMessage: "hi",
      matchAnyPost: true,
      keywords: ["feetbit code"],
    });
    expect(parsed.success).toBe(false);
  });
});

describe("WhatsApp inbound and sign-in codes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // A chat that is attributed to an active campaign, the case where an
    // auto-reply would otherwise go out.
    db.trackedLink.findUnique.mockResolvedValue({
      id: "link_1",
      workspaceId: "ws_1",
      automationId: "auto_1",
      source: "INSTAGRAM",
      automation: {
        id: "auto_1",
        isActive: true,
        instagramAccountId: "acct_1",
        dmMessage: "Thanks for messaging FeetBit!",
        openingDmMessage: null,
      },
    });
    db.whatsAppLead.findFirst.mockResolvedValue(null);
    db.whatsAppLead.upsert.mockResolvedValue({ id: "lead_1", sessionId: "feetbit" });
    db.whatsAppLead.update.mockResolvedValue({});
    db.whatsAppMessage.create.mockResolvedValue({});
    db.whatsAppMessage.count.mockResolvedValue(0);
    provider.sendText.mockResolvedValue({ providerMessageId: "out_1" });
  });

  it("ignores a sign-in code message entirely: no reply, nothing stored", async () => {
    const result = await handleInboundWhatsAppMessage(
      { id: "in_1", chatId: "256700123456@c.us", body: "FeetBit code 482913 (ref: abc1234)" },
      "feetbit"
    );

    expect(result).toEqual({ status: "ignored", reason: "sign-in code message" });
    expect(provider.sendText).not.toHaveBeenCalled();
    expect(db.whatsAppLead.upsert).not.toHaveBeenCalled();
    expect(db.whatsAppMessage.create).not.toHaveBeenCalled();
  });

  it("still auto-replies to an ordinary first message from a campaign link", async () => {
    const result = await handleInboundWhatsAppMessage(
      { id: "in_2", chatId: "256700123456@c.us", body: "Hi! I want these (ref: abc1234)" },
      "feetbit"
    );

    expect(result).toMatchObject({ status: "recorded", replied: true });
    expect(provider.sendText).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: "256700123456@c.us", sessionId: "feetbit" })
    );
  });
});
