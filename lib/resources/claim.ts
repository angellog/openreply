/**
 * Claiming a resource: the rules behind the email gate.
 *
 * Kept out of the route so the parts worth arguing about — what counts as an
 * address, what consent means, what the visitor is told — are testable on their
 * own.
 */

/**
 * The sentence shown next to the consent box, stored verbatim on every lead
 * that ticks it.
 *
 * Changing this wording is a real event: leads captured before the change
 * agreed to the old sentence, and the record has to be able to say so. Add a
 * new constant rather than editing this one in place.
 */
export const MARKETING_CONSENT_TEXT =
  "Email me occasionally with other resources and offers. I can unsubscribe at any time.";

/**
 * Deliberately permissive. This is a gate on a free download, not an identity
 * check: a real address typed with a typo should fail at delivery, where a
 * bounce tells us something true, rather than at a regex that guesses.
 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Addresses that exist to get past gates. Taking them costs nothing and
 *  poisons the list, so they are refused at the door. */
const DISPOSABLE_DOMAINS = new Set([
  "mailinator.com",
  "guerrillamail.com",
  "10minutemail.com",
  "tempmail.com",
  "temp-mail.org",
  "throwawaymail.com",
  "yopmail.com",
  "trashmail.com",
  "sharklasers.com",
  "getnada.com",
]);

export type EmailRejection = "empty" | "too_long" | "malformed" | "disposable";

export type NormalizedEmail =
  | { ok: true; email: string; domain: string }
  | { ok: false; reason: EmailRejection };

export function normalizeEmail(raw: string | null | undefined): NormalizedEmail {
  const email = (raw ?? "").trim().toLowerCase();
  if (!email) return { ok: false, reason: "empty" };
  // RFC 5321's limit. Past this it is not a typo, it is someone probing.
  if (email.length > 254) return { ok: false, reason: "too_long" };
  if (!EMAIL_PATTERN.test(email)) return { ok: false, reason: "malformed" };

  const domain = email.slice(email.lastIndexOf("@") + 1);
  if (DISPOSABLE_DOMAINS.has(domain)) return { ok: false, reason: "disposable" };

  return { ok: true, email, domain };
}

/** What the visitor is told when their address is refused. Specific enough to
 *  fix, never pedantic about what a valid address looks like. */
export function rejectionMessage(reason: EmailRejection): string {
  switch (reason) {
    case "empty":
      return "Enter your email to get the link.";
    case "disposable":
      return "That looks like a temporary address. Use one you can actually receive at.";
    case "too_long":
    case "malformed":
      return "That email address does not look right. Check it and try again.";
  }
}

export function normalizeName(raw: string | null | undefined): string | null {
  const name = (raw ?? "").trim().replace(/\s+/g, " ");
  if (!name) return null;
  return name.slice(0, 120);
}

/** Split a name for the outbound agent, which stores the two separately. */
export function splitName(name: string | null): {
  firstName: string | null;
  lastName: string | null;
} {
  if (!name) return { firstName: null, lastName: null };
  const parts = name.split(" ").filter(Boolean);
  if (parts.length === 1) return { firstName: parts[0], lastName: null };
  return {
    firstName: parts[0],
    lastName: parts.slice(1).join(" "),
  };
}

/**
 * The delivery email. Plain and short on purpose: it exists to put the link in
 * their inbox and to prove the address accepts mail, not to sell anything.
 */
export function buildDeliveryEmail({
  resourceTitle,
  destinationUrl,
  brandName,
  hubUrl,
}: {
  resourceTitle: string;
  destinationUrl: string;
  brandName: string;
  hubUrl: string;
}): { subject: string; text: string; html: string } {
  const subject = `${resourceTitle}`;
  const text = [
    `Here is ${resourceTitle}, as promised.`,
    "",
    destinationUrl,
    "",
    `Everything else ${brandName} has put out is here: ${hubUrl}`,
    "",
    "If you did not ask for this, someone typed your address by mistake. Ignore this and nothing else will arrive.",
  ].join("\n");

  const html = [
    `<p>Here is <strong>${escapeHtml(resourceTitle)}</strong>, as promised.</p>`,
    `<p><a href="${escapeHtml(destinationUrl)}">${escapeHtml(destinationUrl)}</a></p>`,
    `<p>Everything else ${escapeHtml(brandName)} has put out is <a href="${escapeHtml(hubUrl)}">here</a>.</p>`,
    `<p style="color:#666;font-size:13px">If you did not ask for this, someone typed your address by mistake. Ignore this and nothing else will arrive.</p>`,
  ].join("\n");

  return { subject, text, html };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
