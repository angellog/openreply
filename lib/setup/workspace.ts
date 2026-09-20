/**
 * Which workspace the Setup Console operates on.
 *
 * The console has to work *before* anyone can sign in — magic-link login needs
 * Resend, and configuring Resend is one of the things you come here to do. So
 * workspace resolution is deliberately lenient: use the signed-in user's
 * workspace when there is one, otherwise fall back to the single workspace on
 * this instance.
 *
 * The fallback only makes sense because the console is already gated to a
 * machine you control (see `lib/setup/guard.ts`). If more than one workspace
 * exists, there is no safe guess, so it refuses to pick and asks you to sign in.
 */

import { prisma } from "@/lib/db/client";
import { getCurrentWorkspaceId } from "@/lib/auth";

export type WorkspaceSource = "session" | "sole_workspace" | "none" | "ambiguous";

export interface ResolvedSetupWorkspace {
  workspaceId: string | null;
  source: WorkspaceSource;
  name: string | null;
  /** Shown in the console when there is no workspace to act on. */
  message: string | null;
}

export async function resolveSetupWorkspace(): Promise<ResolvedSetupWorkspace> {
  const sessionWorkspaceId = await getCurrentWorkspaceId().catch(() => null);

  if (sessionWorkspaceId) {
    const workspace = await prisma.workspace.findUnique({
      where: { id: sessionWorkspaceId },
      select: { name: true },
    });
    return {
      workspaceId: sessionWorkspaceId,
      source: "session",
      name: workspace?.name ?? null,
      message: null,
    };
  }

  const workspaces = await prisma.workspace
    .findMany({ select: { id: true, name: true }, take: 2 })
    .catch(() => []);

  if (workspaces.length === 1) {
    return {
      workspaceId: workspaces[0].id,
      source: "sole_workspace",
      name: workspaces[0].name,
      message: null,
    };
  }

  if (workspaces.length === 0) {
    return {
      workspaceId: null,
      source: "none",
      name: null,
      message:
        "No workspace exists yet. Create one from the Sign in tab — it takes one click locally.",
    };
  }

  return {
    workspaceId: null,
    source: "ambiguous",
    name: null,
    message:
      "This instance has more than one workspace, so the console cannot guess which one you mean. Sign in and it will use yours.",
  };
}
