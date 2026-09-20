/**
 * OpenWA signs each webhook as `sha256=<hex>` over the raw request body, using
 * the per-webhook secret, in the `X-OpenWA-Signature` header.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export const OPENWA_SIGNATURE_HEADER = "x-openwa-signature";

export function signOpenWaBody(rawBody: string, secret: string) {
  return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

export function verifyOpenWaSignature(
  rawBody: string,
  signature: string | null,
  secret: string | undefined
): boolean {
  if (!secret || !signature) return false;

  const expected = Buffer.from(signOpenWaBody(rawBody, secret));
  const received = Buffer.from(signature);
  if (expected.length !== received.length) return false;

  try {
    return timingSafeEqual(expected, received);
  } catch {
    return false;
  }
}
