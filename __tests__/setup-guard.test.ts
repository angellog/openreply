import { describe, expect, it } from "vitest";
import { evaluateSetupAccess, readPresentedToken } from "@/lib/setup/guard";

const STRONG_TOKEN = "a".repeat(32);

describe("evaluateSetupAccess", () => {
  it("is open in development", () => {
    expect(evaluateSetupAccess({ env: { NODE_ENV: "development" } }).allowed).toBe(
      true
    );
  });

  it("is open in test", () => {
    expect(evaluateSetupAccess({ env: { NODE_ENV: "test" } }).allowed).toBe(true);
  });

  it("is closed in production by default", () => {
    const access = evaluateSetupAccess({ env: { NODE_ENV: "production" } });
    expect(access.allowed).toBe(false);
    expect(access.reason).toBe("production_not_enabled");
  });

  it("can be switched off even in development", () => {
    const access = evaluateSetupAccess({
      env: { NODE_ENV: "development", SETUP_CONSOLE_ENABLED: "false" },
    });
    expect(access.allowed).toBe(false);
    expect(access.reason).toBe("disabled_explicitly");
  });

  it.each(["false", "0", "off", "OFF", " False "])(
    "treats %s as off",
    (value) => {
      expect(
        evaluateSetupAccess({
          env: { NODE_ENV: "development", SETUP_CONSOLE_ENABLED: value },
        }).allowed
      ).toBe(false);
    }
  );

  it("still requires a token when enabled in production", () => {
    const access = evaluateSetupAccess({
      env: { NODE_ENV: "production", SETUP_CONSOLE_ENABLED: "true" },
    });
    expect(access.allowed).toBe(false);
    expect(access.reason).toBe("production_token_missing");
  });

  it("rejects a short production token outright", () => {
    const access = evaluateSetupAccess({
      env: {
        NODE_ENV: "production",
        SETUP_CONSOLE_ENABLED: "true",
        SETUP_CONSOLE_TOKEN: "tooshort",
      },
      presentedToken: "tooshort",
    });
    expect(access.allowed).toBe(false);
    expect(access.reason).toBe("production_token_weak");
  });

  it("rejects a wrong token", () => {
    const access = evaluateSetupAccess({
      env: {
        NODE_ENV: "production",
        SETUP_CONSOLE_ENABLED: "true",
        SETUP_CONSOLE_TOKEN: STRONG_TOKEN,
      },
      presentedToken: "b".repeat(32),
    });
    expect(access.allowed).toBe(false);
    expect(access.reason).toBe("production_token_mismatch");
    expect(access.tokenRequired).toBe(true);
  });

  it("rejects a token that is a prefix of the real one", () => {
    expect(
      evaluateSetupAccess({
        env: {
          NODE_ENV: "production",
          SETUP_CONSOLE_ENABLED: "true",
          SETUP_CONSOLE_TOKEN: STRONG_TOKEN,
        },
        presentedToken: STRONG_TOKEN.slice(0, 16),
      }).allowed
    ).toBe(false);
  });

  it("opens in production for the correct token", () => {
    const access = evaluateSetupAccess({
      env: {
        NODE_ENV: "production",
        SETUP_CONSOLE_ENABLED: "true",
        SETUP_CONSOLE_TOKEN: STRONG_TOKEN,
      },
      presentedToken: STRONG_TOKEN,
    });
    expect(access.allowed).toBe(true);
    expect(access.tokenRequired).toBe(true);
  });

  it("tolerates surrounding whitespace on the presented token", () => {
    expect(
      evaluateSetupAccess({
        env: {
          NODE_ENV: "production",
          SETUP_CONSOLE_ENABLED: "true",
          SETUP_CONSOLE_TOKEN: STRONG_TOKEN,
        },
        presentedToken: `  ${STRONG_TOKEN}  `,
      }).allowed
    ).toBe(true);
  });

  it("keeps the off switch winning over an enabled production token", () => {
    expect(
      evaluateSetupAccess({
        env: {
          NODE_ENV: "production",
          SETUP_CONSOLE_ENABLED: "false",
          SETUP_CONSOLE_TOKEN: STRONG_TOKEN,
        },
        presentedToken: STRONG_TOKEN,
      }).allowed
    ).toBe(false);
  });

  it("explains itself whenever it denies", () => {
    const access = evaluateSetupAccess({ env: { NODE_ENV: "production" } });
    expect(access.message.length).toBeGreaterThan(20);
  });
});

describe("readPresentedToken", () => {
  function makeRequest(header: string | null, url: string) {
    return {
      headers: { get: (name: string) => (name === "x-setup-token" ? header : null) },
      url,
    };
  }

  it("prefers the header", () => {
    expect(
      readPresentedToken(makeRequest("from-header", "https://x.test/?token=from-query"))
    ).toBe("from-header");
  });

  it("falls back to the query string", () => {
    expect(readPresentedToken(makeRequest(null, "https://x.test/?token=from-query"))).toBe(
      "from-query"
    );
  });

  it("returns null when neither is present", () => {
    expect(readPresentedToken(makeRequest(null, "https://x.test/"))).toBeNull();
  });
});
