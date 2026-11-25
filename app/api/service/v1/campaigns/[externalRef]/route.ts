import type { NextRequest } from "next/server";
import { authenticateServiceRequest, serviceError } from "@/lib/service/auth";
import {
  decodeExternalRefParam,
  externalRefSchema,
  formatIssues,
  getServiceCampaign,
  serviceUpdateSchema,
  updateServiceCampaign,
} from "@/lib/service/campaigns";
import { handleServiceError, readJsonBody, serviceJson } from "@/lib/service/respond";

/**
 * /api/service/v1/campaigns/:externalRef
 *
 * GET   the campaign plus stats (DMs sent/skipped/failed, clicks, CTR,
 *       WhatsApp leads, last DM at).
 * PATCH attach { postId, postUrl } after publishing (switches the campaign on
 *       unless isActive: false is sent with it), pause/resume { isActive },
 *       or edit the message fields.
 *
 * Contract and curl examples: docs/kickshot.md.
 */
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ externalRef: string }> };

async function readRef(context: Context) {
  const { externalRef } = await context.params;
  const parsed = externalRefSchema.safeParse(decodeExternalRefParam(externalRef));
  return parsed.success ? parsed.data : null;
}

function notFound(externalRef: string) {
  return serviceError(404, `No campaign with externalRef "${externalRef}"`, {
    code: "NOT_FOUND",
  });
}

function badRef() {
  return serviceError(400, "invalid externalRef", { code: "INVALID_INPUT" });
}

export async function GET(request: NextRequest, context: Context) {
  const auth = await authenticateServiceRequest(request);
  if (!auth.ok) return auth.response;

  const externalRef = await readRef(context);
  if (!externalRef) return badRef();

  const campaign = await getServiceCampaign(auth.workspaceId, externalRef);
  if (!campaign) return notFound(externalRef);
  return serviceJson({ campaign });
}

export async function PATCH(request: NextRequest, context: Context) {
  const auth = await authenticateServiceRequest(request);
  if (!auth.ok) return auth.response;

  const externalRef = await readRef(context);
  if (!externalRef) return badRef();

  const body = await readJsonBody(request);
  if (!body.ok) return body.response;

  const parsed = serviceUpdateSchema.safeParse(body.body);
  if (!parsed.success) {
    return serviceError(400, "invalid input", {
      code: "INVALID_INPUT",
      issues: formatIssues(parsed.error),
    });
  }

  try {
    const campaign = await updateServiceCampaign(auth.workspaceId, externalRef, parsed.data);
    if (!campaign) return notFound(externalRef);
    return serviceJson({ campaign });
  } catch (error) {
    return handleServiceError(error);
  }
}
