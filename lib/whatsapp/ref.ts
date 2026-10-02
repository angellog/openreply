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

/**
 * A campaign's tracked-link slug only exists once the campaign is saved, so
 * the builder can't bake it into the wa.me URL. It stores this placeholder
 * instead, and the /r/<slug> redirect swaps in the real slug at click time.
 */
export const REF_PLACEHOLDER = "{ref}";

/** wa.me destination for the campaign builder, with the ref still a placeholder. */
export function buildWhatsAppHandoffTemplate({
  phone,
  message,
}: {
  phone: string;
  message?: string;
}) {
  return buildWhatsAppHandoffUrl({ phone, slug: REF_PLACEHOLDER, message });
}

/** Replaces the ref placeholder (raw or URL-encoded) with the real slug. */
export function resolveRefPlaceholder(url: string, slug: string) {
  return url
    .replaceAll(REF_PLACEHOLDER, encodeURIComponent(slug))
    .replace(/%7Bref%7D/gi, encodeURIComponent(slug));
}

export function isWhatsAppHandoffUrl(url: string) {
  return /^https:\/\/wa\.me\/\d+/.test(url);
}
