/**
 * Shared response plumbing for the service API routes: JSON body parsing and
 * turning a ServiceCampaignError into the error shape every route returns,
 * `{ error, code?, ... }` with Cache-Control: no-store.
 */

import { NextResponse } from "next/server";
import { serviceError } from "@/lib/service/auth";
import { ServiceCampaignError } from "@/lib/service/campaigns";

export function serviceJson(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export async function readJsonBody(
  request: Request
): Promise<{ ok: true; body: unknown } | { ok: false; response: NextResponse }> {
  try {
    return { ok: true, body: await request.json() };
  } catch {
    return {
      ok: false,
      response: serviceError(400, "body is not valid JSON", { code: "INVALID_JSON" }),
    };
  }
}

export function handleServiceError(error: unknown): NextResponse {
  if (error instanceof ServiceCampaignError) {
    return serviceError(error.status, error.message, { code: error.code, ...error.extra });
  }
  throw error;
}
