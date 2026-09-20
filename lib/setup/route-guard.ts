/**
 * The gate every /api/setup/* handler runs first.
 *
 * Kept separate from `guard.ts` so the policy itself stays free of Next.js
 * imports and can be unit-tested as a pure function.
 */

import { NextResponse, type NextRequest } from "next/server";
import { evaluateSetupAccess, readPresentedToken, type SetupAccess } from "@/lib/setup/guard";

export interface GuardedRequest {
  access: SetupAccess;
  /** Non-null when the request must be rejected — return it as-is. */
  denial: NextResponse | null;
}

export function guardSetupRequest(request: NextRequest): GuardedRequest {
  const access = evaluateSetupAccess({
    presentedToken: readPresentedToken(request),
  });

  if (access.allowed) return { access, denial: null };

  return {
    access,
    denial: NextResponse.json(
      { success: false, error: access.message, reason: access.reason },
      {
        status: access.reason === "production_token_mismatch" ? 401 : 404,
        headers: { "Cache-Control": "no-store" },
      }
    ),
  };
}

export function setupJson(body: unknown, init?: ResponseInit): NextResponse {
  return NextResponse.json(body, {
    ...init,
    headers: { ...init?.headers, "Cache-Control": "no-store" },
  });
}
