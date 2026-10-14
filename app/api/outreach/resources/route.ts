import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { canManageWorkspace, getCurrentWorkspaceContext } from "@/lib/workspace-access";

/** Managing the resources behind the public hub. */

const SLUG = /^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$/;

/** Where a resource may live. An http(s) URL only, so a published gate can
 *  never hand someone a javascript: or data: destination. */
function isUsableDestination(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

export async function GET() {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const [workspace, resources] = await Promise.all([
    prisma.workspace.findUnique({
      where: { id: context.workspaceId },
      select: { name: true, publicSlug: true },
    }),
    prisma.resource.findMany({
      where: { workspaceId: context.workspaceId },
      orderBy: [{ position: "asc" }, { createdAt: "desc" }],
      select: {
        id: true,
        slug: true,
        title: true,
        summary: true,
        description: true,
        destinationUrl: true,
        kind: true,
        isPublished: true,
        createdAt: true,
        _count: { select: { leads: true } },
      },
    }),
  ]);

  // Consented leads are the ones the outbound agent may ever contact, so the
  // two counts are shown separately rather than as one "leads" number.
  const consented = await prisma.resourceLead.groupBy({
    by: ["resourceId"],
    where: { workspaceId: context.workspaceId, consentMarketing: true },
    _count: { _all: true },
  });
  const consentedByResource = new Map(consented.map((row) => [row.resourceId, row._count._all]));

  return NextResponse.json({
    success: true,
    data: {
      workspace,
      resources: resources.map((resource) => ({
        ...resource,
        leadCount: resource._count.leads,
        consentedCount: consentedByResource.get(resource.id) ?? 0,
      })),
    },
  });
}

const createSchema = z.object({
  slug: z.string().min(3).max(60),
  title: z.string().min(1).max(200),
  summary: z.string().min(1).max(300),
  description: z.string().max(4000).optional(),
  destinationUrl: z.string().min(1).max(2000),
  kind: z.string().max(40).optional(),
});

export async function POST(request: NextRequest) {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  if (!canManageWorkspace(context.role)) {
    return NextResponse.json(
      { success: false, error: "Only an admin can add a resource" },
      { status: 403 }
    );
  }

  const parsed = createSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: "Invalid request", issues: parsed.error.issues.slice(0, 5) },
      { status: 422 }
    );
  }

  const slug = parsed.data.slug.trim().toLowerCase();
  if (!SLUG.test(slug)) {
    return NextResponse.json(
      {
        success: false,
        error: "The address can use lower-case letters, digits and dashes only.",
      },
      { status: 422 }
    );
  }
  if (!isUsableDestination(parsed.data.destinationUrl)) {
    return NextResponse.json(
      { success: false, error: "The link has to be a full http(s) URL." },
      { status: 422 }
    );
  }

  const existing = await prisma.resource.findUnique({
    where: { workspaceId_slug: { workspaceId: context.workspaceId, slug } },
    select: { id: true },
  });
  if (existing) {
    return NextResponse.json(
      { success: false, error: `You already have a resource at "${slug}".`, code: "TAKEN" },
      { status: 409 }
    );
  }

  const resource = await prisma.resource.create({
    data: {
      workspaceId: context.workspaceId,
      slug,
      title: parsed.data.title.trim(),
      summary: parsed.data.summary.trim(),
      description: parsed.data.description?.trim() || null,
      destinationUrl: parsed.data.destinationUrl.trim(),
      kind: parsed.data.kind?.trim() || null,
      // Never live on creation. A gate goes public when someone says so.
      isPublished: false,
    },
    select: { id: true, slug: true, title: true, isPublished: true },
  });

  return NextResponse.json({ success: true, data: { resource } });
}

const updateSchema = z.object({
  id: z.string().min(1).max(64),
  title: z.string().min(1).max(200).optional(),
  summary: z.string().min(1).max(300).optional(),
  description: z.string().max(4000).nullish(),
  destinationUrl: z.string().min(1).max(2000).optional(),
  kind: z.string().max(40).nullish(),
  isPublished: z.boolean().optional(),
  position: z.number().int().min(0).max(999).optional(),
});

export async function PATCH(request: NextRequest) {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  if (!canManageWorkspace(context.role)) {
    return NextResponse.json(
      { success: false, error: "Only an admin can change a resource" },
      { status: 403 }
    );
  }

  const parsed = updateSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: "Invalid request" }, { status: 422 });
  }

  const { id, ...changes } = parsed.data;
  if (changes.destinationUrl && !isUsableDestination(changes.destinationUrl)) {
    return NextResponse.json(
      { success: false, error: "The link has to be a full http(s) URL." },
      { status: 422 }
    );
  }

  const existing = await prisma.resource.findFirst({
    where: { id, workspaceId: context.workspaceId },
    select: { id: true },
  });
  if (!existing) {
    return NextResponse.json({ success: false, error: "Resource not found" }, { status: 404 });
  }

  // Publishing needs somewhere to publish to.
  if (changes.isPublished) {
    const workspace = await prisma.workspace.findUnique({
      where: { id: context.workspaceId },
      select: { publicSlug: true },
    });
    if (!workspace?.publicSlug) {
      return NextResponse.json(
        {
          success: false,
          error: "Set a public address for the hub before publishing anything.",
          code: "NO_PUBLIC_SLUG",
        },
        { status: 409 }
      );
    }
  }

  const resource = await prisma.resource.update({
    where: { id: existing.id },
    data: {
      ...(changes.title !== undefined ? { title: changes.title.trim() } : {}),
      ...(changes.summary !== undefined ? { summary: changes.summary.trim() } : {}),
      ...(changes.description !== undefined
        ? { description: changes.description?.trim() || null }
        : {}),
      ...(changes.destinationUrl !== undefined
        ? { destinationUrl: changes.destinationUrl.trim() }
        : {}),
      ...(changes.kind !== undefined ? { kind: changes.kind?.trim() || null } : {}),
      ...(changes.isPublished !== undefined ? { isPublished: changes.isPublished } : {}),
      ...(changes.position !== undefined ? { position: changes.position } : {}),
    },
    select: { id: true, slug: true, title: true, isPublished: true },
  });

  return NextResponse.json({ success: true, data: { resource } });
}
