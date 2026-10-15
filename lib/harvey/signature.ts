/**
 * Harvey runs on a machine the operator controls (a Mac, a Pi, a VPS) and talks
 * to this app over the public internet. Every request it makes is signed the
 * same way OpenWA signs its webhooks — `sha256=<hex>` over the raw body — with
 * one addition: a timestamp inside the signed material, so a captured request
 * cannot be replayed tomorrow.
 *
 * Signed material is `<timestamp>.<rawBody>`. Signing the timestamp (rather
 * than only sending it) is what makes it tamper-proof: an attacker who moves
 * the clock forward invalidates the signature.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export const HARVEY_SIGNATURE_HEADER = "x-harvey-signature";
export const HARVEY_TIMESTAMP_HEADER = "x-harvey-timestamp";
export const HARVEY_AGENT_HEADER = "x-harvey-agent";

/** How far apart Harvey's clock and ours may be before we reject the request. */
export const DEFAULT_TOLERANCE_SECONDS = 300;

export function signHarveyBody(
  rawBody: string,
  timestamp: string,
  secret: string
): string {
  const digest = createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");
  return `sha256=${digest}`;
}

export type HarveyVerifyFailure =
  | "missing_secret"
  | "missing_signature"
  | "missing_timestamp"
  | "bad_timestamp"
  | "stale_timestamp"
  | "bad_signature";

export type HarveyVerifyResult =
  | { ok: true }
  | { ok: false; reason: HarveyVerifyFailure };

/**
 * Returns a reason rather than a bare false: the route turns it into an
 * OperationalEvent, and "stale_timestamp" (Harvey's clock drifted) needs a
 * different fix from "bad_signature" (wrong secret, or someone probing).
 */
export function verifyHarveySignature({
  rawBody,
  signature,
  timestamp,
  secret,
  nowSeconds = Math.floor(Date.now() / 1000),
  toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
}: {
  rawBody: string;
  signature: string | null;
  timestamp: string | null;
  secret: string | undefined;
  nowSeconds?: number;
  toleranceSeconds?: number;
}): HarveyVerifyResult {
  if (!secret) return { ok: false, reason: "missing_secret" };
  if (!signature) return { ok: false, reason: "missing_signature" };
  if (!timestamp) return { ok: false, reason: "missing_timestamp" };

  // Reject anything that isn't a plain integer: "1e10" and " 123" both parse
  // loosely enough elsewhere to be worth refusing here.
  if (!/^\d{1,15}$/.test(timestamp)) {
    return { ok: false, reason: "bad_timestamp" };
  }
  if (Math.abs(nowSeconds - Number(timestamp)) > toleranceSeconds) {
    return { ok: false, reason: "stale_timestamp" };
  }

  const expected = Buffer.from(signHarveyBody(rawBody, timestamp, secret));
  const received = Buffer.from(signature);
  if (expected.length !== received.length) {
    return { ok: false, reason: "bad_signature" };
  }

  try {
    return timingSafeEqual(expected, received)
      ? { ok: true }
      : { ok: false, reason: "bad_signature" };
  } catch {
    return { ok: false, reason: "bad_signature" };
  }
}
