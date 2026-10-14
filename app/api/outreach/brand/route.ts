import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { canManageWorkspace, getCurrentWorkspaceContext } from "@/lib/workspace-access";

/**
 * The brand segment of the public resource URL, /resources/<publicSlug>.
 *
 * Its own endpoint because it is a different kind of thing from a resource: it
 * is the workspace's public identity, it is in every link ever shared, and
 * changing it breaks those links.
 */

/** Lower-case, dashes and digits. It goes in a URL people type and read out. */
const PUBLIC_SLUG = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

/** Paths under /resources that are not brands, plus words that would be
 *  confusing or hostile as a public brand segment. */
const RESERVED = new Set([
  "api",
  "admin",
  "app",
  "dashboard",
  "login",
  "new",
  "settings",
  "resources",
  "null",
  "undefined",
]);

const schema = z.object({
  publicSlug: z.string().min(2).max(40),
});

export async function PATCH(request: NextRequest) {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  if (!canManageWorkspace(context.role)) {
    return NextResponse.json(
      { success: false, error: "Only an admin can change the public address" },
      { status: 403 }
    );
  }

  const parsed = schema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: "Invalid request" }, { status: 422 });
  }

  const publicSlug = parsed.data.publicSlug.trim().toLowerCase();
  if (!PUBLIC_SLUG.test(publicSlug) || RESERVED.has(publicSlug)) {
    return NextResponse.json(
      {
        success: false,
        error:
          "Use 2-40 lower-case letters, digits and dashes, starting and ending with a letter or digit.",
      },
      { status: 422 }
    );
  }

  const taken = await prisma.workspace.findFirst({
    where: { publicSlug, NOT: { id: context.workspaceId } },
    select: { id: true },
  });
  if (taken) {
    return NextResponse.json(
      { success: false, error: `"${publicSlug}" is already taken.`, code: "TAKEN" },
      { status: 409 }
    );
  }

  const workspace = await prisma.workspace.update({
    where: { id: context.workspaceId },
    data: { publicSlug },
    select: { name: true, publicSlug: true },
  });

  return NextResponse.json({ success: true, data: { workspace } });
}
