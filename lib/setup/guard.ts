/**
 * Who is allowed to reach the Setup Console.
 *
 * The console reads and writes `.env`, reveals secrets on request, and can mint
 * a signed-in session without a password. That is exactly the right set of
 * powers for a machine you own and exactly the wrong set to expose on a public
 * deployment, so it is closed by default in production and has to be opened
 * deliberately, with a token.
 *
 * The rules, in order:
 *   1. `SETUP_CONSOLE_ENABLED=false` disables it everywhere, no exceptions.
 *   2. Outside production it is open. This is a local development tool.
 *   3. In production it stays closed unless `SETUP_CONSOLE_ENABLED=true` *and*
 *      `SETUP_CONSOLE_TOKEN` is set to at least 24 characters *and* the request
 *      presents that exact token.
 */

import { timingSafeEqual } from "crypto";

export type SetupDenialReason =
  | "disabled_explicitly"
  | "production_not_enabled"
  | "production_token_missing"
  | "production_token_weak"
  | "production_token_mismatch";

export interface SetupAccess {
  allowed: boolean;
  reason: SetupDenialReason | null;
  /** True when a token is what stands between the caller and the console. */
  tokenRequired: boolean;
  message: string;
}

const MIN_TOKEN_LENGTH = 24;

const DENIAL_MESSAGES: Record<SetupDenialReason, string> = {
  disabled_explicitly:
    "The Setup Console is turned off. Remove SETUP_CONSOLE_ENABLED=false to re-enable it.",
  production_not_enabled:
    "The Setup Console is disabled in production by default. Set SETUP_CONSOLE_ENABLED=true and SETUP_CONSOLE_TOKEN to a long random string to open it.",
  production_token_missing:
    "SETUP_CONSOLE_TOKEN must be set before the Setup Console can be opened in production.",
  production_token_weak: `SETUP_CONSOLE_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters. Generate one with: openssl rand -hex 32`,
  production_token_mismatch:
    "That setup token is not correct.",
};

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  // timingSafeEqual throws on a length mismatch, and the length itself is not
  // the secret, so comparing it up front is fine.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export interface SetupAccessInput {
  env?: NodeJS.ProcessEnv;
  /** Token from the `?token=` query string or the x-setup-token header. */
  presentedToken?: string | null;
}

export function evaluateSetupAccess({
  env = process.env,
  presentedToken = null,
}: SetupAccessInput = {}): SetupAccess {
  const enabled = env.SETUP_CONSOLE_ENABLED?.trim().toLowerCase();

  if (enabled === "false" || enabled === "0" || enabled === "off") {
    return deny("disabled_explicitly", false);
  }

  if (env.NODE_ENV !== "production") {
    return {
      allowed: true,
      reason: null,
      tokenRequired: false,
      message: "Setup Console open (development).",
    };
  }

  if (enabled !== "true" && enabled !== "1" && enabled !== "on") {
    return deny("production_not_enabled", false);
  }

  const token = env.SETUP_CONSOLE_TOKEN?.trim();
  if (!token) return deny("production_token_missing", false);
  if (token.length < MIN_TOKEN_LENGTH) return deny("production_token_weak", false);

  if (!presentedToken || !constantTimeEquals(presentedToken.trim(), token)) {
    return deny("production_token_mismatch", true);
  }

  return {
    allowed: true,
    reason: null,
    tokenRequired: true,
    message: "Setup Console open (production, token accepted).",
  };
}

function deny(reason: SetupDenialReason, tokenRequired: boolean): SetupAccess {
  return {
    allowed: false,
    reason,
    tokenRequired,
    message: DENIAL_MESSAGES[reason],
  };
}

/** Pull the presented token out of a request, header first then query string. */
export function readPresentedToken(request: {
  headers: { get(name: string): string | null };
  nextUrl?: { searchParams: URLSearchParams };
  url?: string;
}): string | null {
  const header = request.headers.get("x-setup-token");
  if (header) return header;

  const params =
    request.nextUrl?.searchParams ??
    (request.url ? new URL(request.url).searchParams : null);
  return params?.get("token") ?? null;
}
