import { describe, expect, it } from "vitest";
import {
  MARKETING_CONSENT_TEXT,
  buildDeliveryEmail,
  normalizeEmail,
  normalizeName,
  rejectionMessage,
  splitName,
} from "@/lib/resources/claim";

describe("normalizeEmail", () => {
  it("lower-cases and trims, so one person is one lead", () => {
    expect(normalizeEmail("  Amina@KampalaKicks.UG ")).toEqual({
      ok: true,
      email: "amina@kampalakicks.ug",
      domain: "kampalakicks.ug",
    });
  });

  it("refuses an empty address", () => {
    expect(normalizeEmail("")).toEqual({ ok: false, reason: "empty" });
    expect(normalizeEmail("   ")).toEqual({ ok: false, reason: "empty" });
    expect(normalizeEmail(null)).toEqual({ ok: false, reason: "empty" });
  });

  it.each(["no-at-sign", "@nothing.com", "spaces in@it.com", "trailing@dot."])(
    "refuses %j",
    (value) => {
      expect(normalizeEmail(value)).toMatchObject({ ok: false, reason: "malformed" });
    }
  );

  it("refuses something far too long to be a typo", () => {
    expect(normalizeEmail(`${"a".repeat(250)}@example.com`)).toEqual({
      ok: false,
      reason: "too_long",
    });
  });

  it("refuses throwaway inboxes, which cost nothing and poison the list", () => {
    expect(normalizeEmail("someone@mailinator.com")).toEqual({
      ok: false,
      reason: "disposable",
    });
    expect(normalizeEmail("Someone@YOPMAIL.com")).toEqual({
      ok: false,
      reason: "disposable",
    });
  });

  it("accepts a plus-addressed and a subdomained address", () => {
    expect(normalizeEmail("a+vantik@gmail.com")).toMatchObject({ ok: true });
    expect(normalizeEmail("a@mail.corp.example.co.ug")).toMatchObject({ ok: true });
  });

  it("tells the visitor what to do about it", () => {
    expect(rejectionMessage("disposable")).toContain("temporary");
    expect(rejectionMessage("empty")).toContain("Enter your email");
    expect(rejectionMessage("malformed")).toContain("does not look right");
  });
});

describe("names", () => {
  it("collapses whitespace and caps the length", () => {
    expect(normalizeName("  Amina   Nakato  ")).toBe("Amina Nakato");
    expect(normalizeName("")).toBeNull();
    expect(normalizeName(null)).toBeNull();
    expect(normalizeName("x".repeat(200))?.length).toBe(120);
  });

  it("splits for the outbound agent, which stores the two apart", () => {
    expect(splitName("Amina Nakato")).toEqual({ firstName: "Amina", lastName: "Nakato" });
    expect(splitName("Amina")).toEqual({ firstName: "Amina", lastName: null });
    expect(splitName("Amina Grace Nakato")).toEqual({
      firstName: "Amina",
      lastName: "Grace Nakato",
    });
    expect(splitName(null)).toEqual({ firstName: null, lastName: null });
  });
});

describe("the delivery email", () => {
  const message = buildDeliveryEmail({
    resourceTitle: "The Wholesale Checklist",
    destinationUrl: "https://drive.google.com/file/d/abc123/view",
    brandName: "Vantik",
    hubUrl: "https://app.test/resources/vantik",
  });

  it("carries the link in both parts", () => {
    expect(message.text).toContain("https://drive.google.com/file/d/abc123/view");
    expect(message.html).toContain("https://drive.google.com/file/d/abc123/view");
  });

  it("names the thing in the subject, so it is findable later", () => {
    expect(message.subject).toBe("The Wholesale Checklist");
  });

  it("tells someone who never asked that nothing else is coming", () => {
    expect(message.text).toContain("did not ask for this");
  });

  it("escapes a title that contains markup", () => {
    const hostile = buildDeliveryEmail({
      resourceTitle: '<img src=x onerror="alert(1)">',
      destinationUrl: "https://example.com/x",
      brandName: "Vantik",
      hubUrl: "https://app.test/resources/vantik",
    });
    expect(hostile.html).not.toContain("<img");
    expect(hostile.html).toContain("&lt;img");
  });
});

describe("the consent sentence", () => {
  it("says what it is for and that it can be undone", () => {
    expect(MARKETING_CONSENT_TEXT).toMatch(/unsubscribe/i);
    expect(MARKETING_CONSENT_TEXT).toMatch(/email me/i);
  });

  it("is a single stable string, because leads record the wording they saw", () => {
    // If this fails, the wording changed. That is allowed, but old leads
    // agreed to the old sentence: add a new constant rather than editing this.
    expect(MARKETING_CONSENT_TEXT).toBe(
      "Email me occasionally with other resources and offers. I can unsubscribe at any time."
    );
  });
});
