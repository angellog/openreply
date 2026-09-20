/**
 * WhatsApp handoff refs
 *
 * A campaign's DM hands the commenter a tracked link (`/r/<slug>`) that
 * redirects to wa.me with the slug embedded in the pre-filled text. The
 * customer sends that text as their first message, which is what lets an
 * inbound WhatsApp chat be attributed back to the post it came from — and it
 * keeps the flow inbound-first, which is what keeps the number safe.
 */

const REF_PATTERN = /ref:\s*([A-Za-z0-9_-]{4,64})/i;

export function formatRef(slug: string) {
  return `(ref: ${slug})`;
}

/** Extracts a tracked-link slug from an inbound message body, if present. */
export function extractRefSlug(body: string | null | undefined): string | null {
  if (!body) return null;
  return REF_PATTERN.exec(body)?.[1] ?? null;
}

/** Digits-only phone, as wa.me requires (no +, spaces or dashes). */
export function normalizeWhatsAppPhone(phone: string) {
  return phone.replace(/\D/g, "");
}

/** Provider chat id for a phone number, e.g. "256700123456@c.us". */
export function toChatId(phone: string) {
  return `${normalizeWhatsAppPhone(phone)}@c.us`;
}

/** Phone number out of a provider chat id, or null for groups and channels. */
export function chatIdToPhone(chatId: string): string | null {
  const [user, domain] = chatId.split("@");
  if (domain !== "c.us" || !/^\d+$/.test(user ?? "")) return null;
  return user;
}

/**
 * The wa.me destination a campaign's tracked link points at. The ref is what
 * the customer's first message carries back to us.
 */
export function buildWhatsAppHandoffUrl({
  phone,
  slug,
  message,
}: {
  phone: string;
  slug: string;
  message?: string;
}) {
  const text = `${message?.trim() || "Hi! I saw your post"} ${formatRef(slug)}`;
  return `https://wa.me/${normalizeWhatsAppPhone(phone)}?text=${encodeURIComponent(text)}`;
}
