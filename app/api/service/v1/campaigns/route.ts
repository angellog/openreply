import type { NextRequest } from "next/server";
import { authenticateServiceRequest, serviceError } from "@/lib/service/auth";
import {
  EXTERNAL_REF_MAX,
  formatIssues,
  LIST_LIMIT_DEFAULT,
  LIST_LIMIT_MAX,
  listServiceCampaigns,
  serviceCreateSchema,
  upsertServiceCampaign,
} from "@/lib/service/campaigns";
import { handleServiceError, readJsonBody, serviceJson } from "@/lib/service/respond";

/**
 * /api/service/v1/campaigns — the machine-to-machine door for KickShot Studio.
 *
 * GET  ?prefix=kickshot:&instagramUsername=&limit=  campaigns made through
 *      this API (never dashboard-built ones), newest first, with stats.
 * POST create, idempotent on externalRef: 201 when new, 200 with the updated
 *      existing campaign when the ref is already taken.
 *
 * Contract and curl examples: docs/kickshot.md.
 */
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const auth = await authenticateServiceRequest(request);
  if (!auth.ok) return auth.response;

  const params = request.nextUrl.searchParams;
  const prefix = params.get("prefix");
  if (prefix !== null && prefix.length > EXTERNAL_REF_MAX) {
    return serviceError(400, `prefix must be at most ${EXTERNAL_REF_MAX} characters`, {
      code: "INVALID_INPUT",
    });
  }

  const rawLimit = params.get("limit");
  const limit = rawLimit === null ? LIST_LIMIT_DEFAULT : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > LIST_LIMIT_MAX) {
    return serviceError(400, `limit must be an integer from 1 to ${LIST_LIMIT_MAX}`, {
      code: "INVALID_INPUT",
    });
  }

  const campaigns = await listServiceCampaigns(auth.workspaceId, {
    prefix: prefix || null,
    instagramUsername: params.get("instagramUsername"),
    limit,
  });
  return serviceJson({ campaigns });
}

export async function POST(request: NextRequest) {
  const auth = await authenticateServiceRequest(request);
  if (!auth.ok) return auth.response;

  const body = await readJsonBody(request);
  if (!body.ok) return body.response;

  const parsed = serviceCreateSchema.safeParse(body.body);
  if (!parsed.success) {
    return serviceError(400, "invalid input", {
      code: "INVALID_INPUT",
      issues: formatIssues(parsed.error),
    });
  }

  try {
    const { campaign, created } = await upsertServiceCampaign(auth.workspaceId, parsed.data);
    return serviceJson({ campaign, created }, created ? 201 : 200);
  } catch (error) {
    return handleServiceError(error);
  }
}
