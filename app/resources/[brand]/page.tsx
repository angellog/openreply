import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db/client";

/**
 * A brand's resource hub. One page that lists everything it has published, so
 * a single link in a bio covers every lead magnet instead of one link per
 * thing.
 */

type HubProps = { params: Promise<{ brand: string }> };

async function getBrand(brand: string) {
  return prisma.workspace.findUnique({
    where: { publicSlug: brand },
    select: {
      id: true,
      name: true,
      publicSlug: true,
      resources: {
        where: { isPublished: true },
        orderBy: [{ position: "asc" }, { createdAt: "desc" }],
        select: { slug: true, title: true, summary: true, kind: true },
      },
    },
  });
}

export async function generateMetadata({ params }: HubProps): Promise<Metadata> {
  const { brand } = await params;
  const workspace = await getBrand(brand);
  if (!workspace) return { title: "Not found" };

  return {
    title: `${workspace.name} — Resources`,
    description: `Free resources from ${workspace.name}.`,
    robots: { index: true, follow: true },
  };
}

export default async function ResourceHubPage({ params }: HubProps) {
  const { brand } = await params;
  const workspace = await getBrand(brand);
  if (!workspace) notFound();

  return (
    <main className="mx-auto max-w-2xl px-4 py-14 sm:py-20">
      <header>
        <p className="text-sm font-medium tracking-wide text-zinc-500 uppercase">
          {workspace.name}
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-zinc-900 sm:text-4xl">
          Resources
        </h1>
        <p className="mt-3 text-base text-zinc-600">
          Everything we have put out, in one place. Free, and yours for an email
          address.
        </p>
      </header>

      {workspace.resources.length === 0 ? (
        <p className="mt-10 text-sm text-zinc-500">
          Nothing published yet. Check back shortly.
        </p>
      ) : (
        <ul className="mt-10 space-y-3">
          {workspace.resources.map((resource) => (
            <li key={resource.slug}>
              <Link
                href={`/resources/${workspace.publicSlug}/${resource.slug}`}
                className="block rounded-lg border border-zinc-200 bg-white p-5 transition-colors hover:border-zinc-900"
              >
                {resource.kind && (
                  <span className="text-xs font-medium tracking-wide text-zinc-500 uppercase">
                    {resource.kind}
                  </span>
                )}
                <h2 className="mt-1 text-lg font-semibold text-zinc-900">
                  {resource.title}
                </h2>
                <p className="mt-1 text-sm text-zinc-600">{resource.summary}</p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
