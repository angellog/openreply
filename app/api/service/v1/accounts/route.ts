import type { NextRequest } from "next/server";
import { authenticateServiceRequest } from "@/lib/service/auth";
import { listServiceAccounts } from "@/lib/service/campaigns";
import { serviceJson } from "@/lib/service/respond";

/**
 * GET /api/service/v1/accounts
 *
 * Every Instagram account in the service workspace, and whether it can send a
 * private reply right now. KickShot reads this before booking a reel on a page
 * so it never creates a campaign that cannot fire. Contract: docs/kickshot.md.
 */
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const auth = await authenticateServiceRequest(request);
  if (!auth.ok) return auth.response;

  const accounts = await listServiceAccounts(auth.workspaceId);
  return serviceJson({ accounts });
}
