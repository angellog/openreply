import { NextResponse } from "next/server";
import { getCurrentWorkspaceId } from "@/lib/auth";
import { listSystems, SYSTEM_FLOWS } from "@/lib/systems/registry";
import { readSystemStatuses, worstState } from "@/lib/systems/status";

/**
 * One request, every system's state. Read by the sidebar dots, the systems map
 * and the guide, so those three can never disagree about whether Harvey is up.
 */

export const runtime = "nodejs";

export async function GET() {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const statuses = await readSystemStatuses(workspaceId);

  return NextResponse.json({
    success: true,
    data: {
      statuses,
      worst: worstState(statuses),
      // The registry travels with the statuses so the client never has to
      // import it and ship the prose to every page.
      systems: listSystems().map((system) => ({
        id: system.id,
        name: system.name,
        tagline: system.tagline,
        origin: system.origin,
        runtime: system.runtime,
        pages: system.pages,
        owns: system.owns,
        limits: system.limits,
        setup: system.setup,
      })),
      flows: SYSTEM_FLOWS,
    },
  });
}
