/**
 * Sign-in codes are never auto-answered.
 *
 * The WhatsApp number OpenReply replies from is the same OpenWA session that
 * carries the FeetBit store's sign-in flow ("FeetBit code 123456"). A campaign
 * that answered one of those messages would bury the code under a promo, or
 * worse, look to the customer like the code itself. So any message that is
 * part of that flow is excluded from every automatic reply path — WhatsApp
 * inbound, Instagram DM keyword triggers, and comment private replies —
 * whatever a campaign's keywords say, including "match any word" campaigns.
 *
 * Matching is deliberately loose: case, spacing, punctuation and zero-width
 * characters between the words do not matter ("FeetBit code", "feetbit-code",
 * "FEET BIT CODE:", "FeetBit\u200Bcode"). A false positive costs one missed
 * promo reply; a false negative costs a customer their sign-in.
 */

const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF]/g;

/**
 * "feet", optional gap, "bit", then "code" — directly, or after one of the
 * words a sign-in message puts in between ("FeetBit sign-in code",
 * "FeetBit verification code", "FeetBit OTP code").
 */
const GAP = "[^\\p{L}\\p{N}]*";
const QUALIFIER =
  "(?:sign[^\\p{L}\\p{N}]*in|log[^\\p{L}\\p{N}]*in|verification|verify|security|access|one[^\\p{L}\\p{N}]*time|otp)";
const SIGN_IN_CODE_PATTERN = new RegExp(
  `feet[\\s\\p{P}\\p{S}_]*bit${GAP}(?:${QUALIFIER}${GAP})?code`,
  "iu"
);

export function isSignInCodeMessage(text: string | null | undefined): boolean {
  if (!text) return false;
  return SIGN_IN_CODE_PATTERN.test(text.replace(ZERO_WIDTH, ""));
}

/**
 * A campaign keyword that would itself match the sign-in flow. Refused at
 * creation time so nobody builds a campaign that could only ever be blocked.
 */
export function isSignInCodeKeyword(keyword: string): boolean {
  return isSignInCodeMessage(keyword);
}

export const SIGN_IN_CODE_KEYWORD_ERROR =
  'Keywords cannot target "FeetBit code" — that is the store\'s sign-in flow, which campaigns never answer.';
