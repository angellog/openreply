import { describe, expect, it } from "vitest";
import {
  DEFAULT_TOLERANCE_SECONDS,
  signHarveyBody,
  verifyHarveySignature,
} from "@/lib/harvey/signature";

const SECRET = "harvey-node-secret";
const BODY = JSON.stringify({ kind: "sync", prospects: [{ id: "p1" }] });
const TS = "1760000000";
const NOW = Number(TS);

function verify(overrides: Partial<Parameters<typeof verifyHarveySignature>[0]> = {}) {
  return verifyHarveySignature({
    rawBody: BODY,
    signature: signHarveyBody(BODY, TS, SECRET),
    timestamp: TS,
    secret: SECRET,
    nowSeconds: NOW,
    ...overrides,
  });
}

describe("signHarveyBody", () => {
  it("produces a sha256=<hex> digest", () => {
    expect(signHarveyBody(BODY, TS, SECRET)).toMatch(/^sha256=[a-f0-9]{64}$/);
  });

  it("binds the timestamp into the digest", () => {
    expect(signHarveyBody(BODY, TS, SECRET)).not.toBe(
      signHarveyBody(BODY, "1760000001", SECRET)
    );
  });

  it("binds the body into the digest", () => {
    expect(signHarveyBody(BODY, TS, SECRET)).not.toBe(
      signHarveyBody(BODY + " ", TS, SECRET)
    );
  });
});

describe("verifyHarveySignature", () => {
  it("accepts a correctly signed request", () => {
    expect(verify()).toEqual({ ok: true });
  });

  it("accepts clock drift inside the tolerance", () => {
    expect(verify({ nowSeconds: NOW + DEFAULT_TOLERANCE_SECONDS })).toEqual({ ok: true });
    expect(verify({ nowSeconds: NOW - DEFAULT_TOLERANCE_SECONDS })).toEqual({ ok: true });
  });

  it("rejects a replay from outside the tolerance", () => {
    expect(verify({ nowSeconds: NOW + DEFAULT_TOLERANCE_SECONDS + 1 })).toEqual({
      ok: false,
      reason: "stale_timestamp",
    });
  });

  it("rejects a tampered body", () => {
    expect(verify({ rawBody: BODY.replace("p1", "p2") })).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("rejects a moved timestamp, because the timestamp is signed", () => {
    expect(verify({ timestamp: String(NOW + 1), nowSeconds: NOW + 1 })).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("rejects the wrong secret", () => {
    expect(verify({ secret: "not-the-secret" })).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("refuses to verify when no secret is configured", () => {
    expect(verify({ secret: undefined })).toEqual({ ok: false, reason: "missing_secret" });
    expect(verify({ secret: "" })).toEqual({ ok: false, reason: "missing_secret" });
  });

  it("names the missing header", () => {
    expect(verify({ signature: null })).toEqual({ ok: false, reason: "missing_signature" });
    expect(verify({ timestamp: null })).toEqual({ ok: false, reason: "missing_timestamp" });
    // An empty header is absent, not malformed.
    expect(verify({ timestamp: "" })).toEqual({ ok: false, reason: "missing_timestamp" });
    expect(verify({ signature: "" })).toEqual({ ok: false, reason: "missing_signature" });
  });

  it.each([" 1760000000", "1e10", "-1760000000", "17600000000000000", "abc"])(
    "rejects malformed timestamp %j",
    (timestamp) => {
      expect(verify({ timestamp })).toEqual({ ok: false, reason: "bad_timestamp" });
    }
  );

  it("does not throw on a signature of a different length", () => {
    expect(verify({ signature: "sha256=short" })).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });
});

/**
 * Cross-language golden vector. The Python side (harvey/integrations/openreply.py,
 * tests/test_openreply_bridge.py) signs this exact body/timestamp/secret and must
 * produce this exact digest. If either side changes its signed material, one of
 * these two tests fails instead of the bridge silently 401-ing in production.
 */
describe("cross-language golden vector", () => {
  const GOLDEN_BODY =
    '{"alpha":2,"kind":"sync","prospects":[{"email":"a@b.co","id":"p1"}],"zeta":1}';
  const GOLDEN_TIMESTAMP = "1760000000";
  const GOLDEN_SECRET = "shared-secret";
  const GOLDEN_SIGNATURE =
    "sha256=1d44b02d29d2b1f440b6561f23669c6ae0eebf75331336bb665a348713786406";

  it("matches the digest produced by Harvey's Python signer", () => {
    expect(signHarveyBody(GOLDEN_BODY, GOLDEN_TIMESTAMP, GOLDEN_SECRET)).toBe(
      GOLDEN_SIGNATURE
    );
  });

  it("verifies a request signed by Harvey", () => {
    expect(
      verifyHarveySignature({
        rawBody: GOLDEN_BODY,
        signature: GOLDEN_SIGNATURE,
        timestamp: GOLDEN_TIMESTAMP,
        secret: GOLDEN_SECRET,
        nowSeconds: Number(GOLDEN_TIMESTAMP),
      })
    ).toEqual({ ok: true });
  });
});
