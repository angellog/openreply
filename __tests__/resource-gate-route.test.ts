import { beforeEach, describe, expect, it, vi } from "vitest";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    resource: { findFirst: vi.fn() },
    lead: { upsert: vi.fn(), update: vi.fn() },
    trackedLink: { findUnique: vi.fn() },
    opEvent: { create: vi.fn() },
    sendEmail: vi.fn(),
  },
}));

vi.mock("@/lib/db/client", () => ({
  prisma: {
    resource: mocks.resource,
    resourceLead: mocks.lead,
    trackedLink: mocks.trackedLink,
    operationalEvent: mocks.opEvent,
  },
}));
vi.mock("@/lib/email/send", () => ({ sendEmail: mocks.sendEmail }));
vi.mock("@/lib/tracking/server", () => ({
  getRequestIp: () => "1.2.3.4",
  hashClickIp: () => "hashed",
}));

import { NextRequest } from "next/server";
import { POST } from "../app/api/resources/[brand]/[slug]/claim/route";
import { MARKETING_CONSENT_TEXT } from "@/lib/resources/claim";

const DRIVE_URL = "https://drive.google.com/file/d/abc123/view";

function claim(body: unknown, brand = "vantik", slug = "wholesale-checklist") {
  return POST(
    new NextRequest(`https://app.test/api/resources/${brand}/${slug}/claim`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ brand, slug }) }
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resource.findFirst.mockResolvedValue({
    id: "res_1",
    workspaceId: "ws_1",
    title: "The Wholesale Checklist",
    destinationUrl: DRIVE_URL,
    workspace: { name: "Vantik", publicSlug: "vantik" },
  });
  mocks.lead.upsert.mockResolvedValue({});
  mocks.lead.update.mockResolvedValue({});
  mocks.trackedLink.findUnique.mockResolvedValue(null);
  mocks.sendEmail.mockResolvedValue({ ok: true });
  mocks.opEvent.create.mockResolvedValue({});
});

describe("POST claim", () => {
  it("hands back the link and emails a copy", async () => {
    const response = await claim({ email: "amina@kampalakicks.ug" });
    const json = await response.json();

    expect(json.data).toEqual({ url: DRIVE_URL, emailed: true });
    expect(mocks.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: "amina@kampalakicks.ug" })
    );
  });

  it("records consent with its wording and time only when the box was ticked", async () => {
    await claim({ email: "a@b.co", consentMarketing: true });

    const created = mocks.lead.upsert.mock.calls[0][0].create;
    expect(created.consentMarketing).toBe(true);
    expect(created.consentText).toBe(MARKETING_CONSENT_TEXT);
    expect(created.consentedAt).toBeInstanceOf(Date);
  });

  it("stores no consent wording when the box was left alone", async () => {
    await claim({ email: "a@b.co" });

    const created = mocks.lead.upsert.mock.calls[0][0].create;
    expect(created.consentMarketing).toBe(false);
    expect(created.consentText).toBeNull();
    expect(created.consentedAt).toBeNull();
  });

  it("still hands over the resource without consent, which is what makes a tick mean anything", async () => {
    const json = await (await claim({ email: "a@b.co" })).json();
    expect(json.data.url).toBe(DRIVE_URL);
  });

  it("never withdraws an earlier opt-in on a later un-ticked download", async () => {
    await claim({ email: "a@b.co", consentMarketing: false });

    const update = mocks.lead.upsert.mock.calls[0][0].update;
    // undefined leaves the stored column alone; false would overwrite it.
    expect(update.consentMarketing).toBeUndefined();
    expect(update.consentText).toBeUndefined();
  });

  it("moves consent forward when they do tick it the second time", async () => {
    await claim({ email: "a@b.co", consentMarketing: true });

    const update = mocks.lead.upsert.mock.calls[0][0].update;
    expect(update.consentMarketing).toBe(true);
  });

  it("refuses a throwaway address with a usable message", async () => {
    const response = await claim({ email: "x@mailinator.com" });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ code: "disposable" });
    expect(mocks.lead.upsert).not.toHaveBeenCalled();
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it("404s an unpublished or unknown resource without saying which", async () => {
    mocks.resource.findFirst.mockResolvedValue(null);

    const response = await claim({ email: "a@b.co" });

    expect(response.status).toBe(404);
    expect(mocks.lead.upsert).not.toHaveBeenCalled();
  });

  it("scopes the lookup to the brand, so one brand cannot serve another's gate", async () => {
    await claim({ email: "a@b.co" }, "feetbit", "wholesale-checklist");

    expect(mocks.resource.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          slug: "wholesale-checklist",
          isPublished: true,
          workspace: { publicSlug: "feetbit" },
        }),
      })
    );
  });

  it("attaches the tracked link that brought them", async () => {
    mocks.trackedLink.findUnique.mockResolvedValue({ id: "link_1", workspaceId: "ws_1" });

    await claim({ email: "a@b.co", ref: "hv_abc123" });

    const created = mocks.lead.upsert.mock.calls[0][0].create;
    expect(created.refSlug).toBe("hv_abc123");
    expect(created.trackedLinkId).toBe("link_1");
  });

  it("keeps a foreign workspace's ref as a note but does not attach it", async () => {
    mocks.trackedLink.findUnique.mockResolvedValue({ id: "link_x", workspaceId: "ws_other" });

    await claim({ email: "a@b.co", ref: "other_slug" });

    const created = mocks.lead.upsert.mock.calls[0][0].create;
    expect(created.refSlug).toBe("other_slug");
    expect(created.trackedLinkId).toBeNull();
  });

  it("does not turn a mail failure into an error on the visitor's screen", async () => {
    mocks.sendEmail.mockResolvedValue({ ok: false, error: "domain not verified" });

    const response = await claim({ email: "a@b.co" });
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data).toEqual({ url: DRIVE_URL, emailed: false });
  });

  it("records a failed send on the lead and in the operational log", async () => {
    mocks.sendEmail.mockResolvedValue({ ok: false, error: "domain not verified" });

    await claim({ email: "a@b.co" });

    expect(mocks.lead.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ deliveryStatus: "FAILED" }),
      })
    );
    expect(mocks.opEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ level: "WARNING" }),
      })
    );
  });

  it("marks delivery sent on success, which is what gates the outbound export", async () => {
    await claim({ email: "a@b.co" });

    expect(mocks.lead.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ deliveryStatus: "SENT", deliveryError: null }),
      })
    );
  });
});
