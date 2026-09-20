import { describe, expect, it } from "vitest";
import {
  buildWhatsAppHandoffUrl,
  chatIdToPhone,
  extractRefSlug,
  formatRef,
  normalizeWhatsAppPhone,
  toChatId,
} from "@/lib/whatsapp/ref";
import {
  signOpenWaBody,
  verifyOpenWaSignature,
} from "@/lib/whatsapp/signature";

describe("whatsapp refs", () => {
  it("round-trips a slug through the handoff url and the reply", () => {
    const url = buildWhatsAppHandoffUrl({
      phone: "+256 700-123456",
      slug: "aB3_x9Z",
      message: "Hi! I want these",
    });

    expect(url.startsWith("https://wa.me/256700123456?text=")).toBe(true);

    const prefilled = decodeURIComponent(url.split("text=")[1]);
    expect(extractRefSlug(prefilled)).toBe("aB3_x9Z");
  });

  it("finds the ref even when the customer types around it", () => {
    expect(extractRefSlug("do you have size 43? (ref: aB3_x9Z) thanks")).toBe(
      "aB3_x9Z"
    );
    expect(extractRefSlug("REF: SLUG1234")).toBe("SLUG1234");
  });

  it("returns null when there is no ref", () => {
    expect(extractRefSlug("how much are these")).toBeNull();
    expect(extractRefSlug("")).toBeNull();
    expect(extractRefSlug(null)).toBeNull();
  });

  it("normalises phones and chat ids", () => {
    expect(normalizeWhatsAppPhone("+256 700 123 456")).toBe("256700123456");
    expect(toChatId("+256700123456")).toBe("256700123456@c.us");
    expect(chatIdToPhone("256700123456@c.us")).toBe("256700123456");
    // Groups and channels carry no phone number.
    expect(chatIdToPhone("120363000000000000@g.us")).toBeNull();
  });

  it("keeps the ref parseable with no custom message", () => {
    const url = buildWhatsAppHandoffUrl({ phone: "256700123456", slug: "zz99zz99" });
    expect(extractRefSlug(decodeURIComponent(url))).toBe("zz99zz99");
    expect(formatRef("zz99zz99")).toBe("(ref: zz99zz99)");
  });
});

describe("openwa webhook signatures", () => {
  const secret = "test-secret";
  const body = JSON.stringify({ event: "message.received", data: { id: "1" } });

  it("accepts a signature produced with the same secret", () => {
    expect(verifyOpenWaSignature(body, signOpenWaBody(body, secret), secret)).toBe(
      true
    );
  });

  it("uses the sha256= prefix OpenWA sends", () => {
    expect(signOpenWaBody(body, secret)).toMatch(/^sha256=[a-f0-9]{64}$/);
  });

  it("rejects a tampered body, a wrong secret, and missing input", () => {
    const signature = signOpenWaBody(body, secret);
    expect(verifyOpenWaSignature(body + " ", signature, secret)).toBe(false);
    expect(verifyOpenWaSignature(body, signature, "other-secret")).toBe(false);
    expect(verifyOpenWaSignature(body, null, secret)).toBe(false);
    expect(verifyOpenWaSignature(body, signature, undefined)).toBe(false);
    expect(verifyOpenWaSignature(body, "sha256=short", secret)).toBe(false);
  });
});
