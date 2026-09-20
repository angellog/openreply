/**
 * Target CRUD for the Setup Console.
 *
 * These write the same `Automation` rows the dashboard's campaign builder
 * writes, so a target added here is a campaign there. The separate endpoint
 * exists because the console has to work before sign-in: it resolves the
 * workspace leniently (see `lib/setup/workspace.ts`) instead of hard-requiring
 * a session, and it is protected by the setup guard rather than by auth.
 */

import type { NextRequest } from "next/server";
import { guardSetupRequest, setupJson } from "@/lib/setup/route-guard";
import { resolveSetupWorkspace } from "@/lib/setup/workspace";
import {
  TargetError,
  createTarget,
  deleteTarget,
  listTargets,
  patchTarget,
  targetInputSchema,
  targetPatchSchema,
} from "@/lib/setup/targets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function requireWorkspace() {
  const workspace = await resolveSetupWorkspace();
  if (!workspace.workspaceId) {
    throw new TargetError(
      workspace.message ?? "No workspace available.",
      409
    );
  }
  return workspace.workspaceId;
}

function handleError(error: unknown) {
  if (error instanceof TargetError) {
    return setupJson({ success: false, error: error.message }, { status: error.status });
  }
  return setupJson(
    {
      success: false,
      error: error instanceof Error ? error.message : "Unexpected error",
    },
    { status: 500 }
  );
}

export async function GET(request: NextRequest) {
  const { denial } = guardSetupRequest(request);
  if (denial) return denial;

  try {
    const workspaceId = await requireWorkspace();
    return setupJson({ success: true, data: await listTargets(workspaceId) });
  } catch (error) {
    return handleError(error);
  }
}

export async function POST(request: NextRequest) {
  const { denial } = guardSetupRequest(request);
  if (denial) return denial;

  try {
    const workspaceId = await requireWorkspace();
    const parsed = targetInputSchema.safeParse(await request.json().catch(() => null));

    if (!parsed.success) {
      return setupJson(
        {
          success: false,
          error: "Some fields need attention",
          errors: parsed.error.flatten().fieldErrors,
        },
        { status: 400 }
      );
    }

    const target = await createTarget(workspaceId, parsed.data);
    return setupJson({ success: true, data: target }, { status: 201 });
  } catch (error) {
    return handleError(error);
  }
}

export async function PATCH(request: NextRequest) {
  const { denial } = guardSetupRequest(request);
  if (denial) return denial;

  try {
    const workspaceId = await requireWorkspace();
    const id = request.nextUrl.searchParams.get("id");
    if (!id) {
      return setupJson({ success: false, error: "Missing target id" }, { status: 400 });
    }

    const parsed = targetPatchSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return setupJson({ success: false, error: "Invalid patch" }, { status: 400 });
    }

    return setupJson({
      success: true,
      data: await patchTarget(workspaceId, id, parsed.data),
    });
  } catch (error) {
    return handleError(error);
  }
}

export async function DELETE(request: NextRequest) {
  const { denial } = guardSetupRequest(request);
  if (denial) return denial;

  try {
    const workspaceId = await requireWorkspace();
    const id = request.nextUrl.searchParams.get("id");
    if (!id) {
      return setupJson({ success: false, error: "Missing target id" }, { status: 400 });
    }

    await deleteTarget(workspaceId, id);
    return setupJson({ success: true, data: { deleted: true } });
  } catch (error) {
    return handleError(error);
  }
}
