import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db/client";
import ResourceGateForm from "@/components/resource-gate-form";
import { MARKETING_CONSENT_TEXT } from "@/lib/resources/claim";

/**
 * One resource behind its gate.
 *
 * The destination URL is deliberately never rendered here. It is returned by
 * the claim endpoint after an address is given, so the link is not sitting in
 * the page source for anyone who opens dev tools.
 */

type GateProps = { params: Promise<{ brand: string; slug: string }> };

async function getResource(brand: string, slug: string) {
  return prisma.resource.findFirst({
    where: { slug, isPublished: true, workspace: { publicSlug: brand } },
    select: {
      slug: true,
      title: true,
      summary: true,
      description: true,
      kind: true,
      workspace: { select: { name: true, publicSlug: true } },
    },
  });
}

export async function generateMetadata({ params }: GateProps): Promise<Metadata> {
  const { brand, slug } = await params;
  const resource = await getResource(brand, slug);
  if (!resource) return { title: "Not found" };

  return {
    title: `${resource.title} — ${resource.workspace.name}`,
    description: resource.summary,
    openGraph: { title: resource.title, description: resource.summary },
  };
}

export default async function ResourceGatePage({ params }: GateProps) {
  const { brand, slug } = await params;
  const resource = await getResource(brand, slug);
  if (!resource) notFound();

  return (
    <main className="mx-auto max-w-xl px-4 py-14 sm:py-20">
      <Link
        href={`/resources/${resource.workspace.publicSlug}`}
        className="text-sm text-zinc-500 hover:text-zinc-900"
      >
        {resource.workspace.name}
      </Link>

      <header className="mt-6">
        {resource.kind && (
          <span className="text-xs font-medium tracking-wide text-zinc-500 uppercase">
            {resource.kind}
          </span>
        )}
        <h1 className="mt-1 text-3xl font-semibold tracking-tight text-zinc-900 sm:text-4xl">
          {resource.title}
        </h1>
        <p className="mt-3 text-lg text-zinc-600">{resource.summary}</p>
        {resource.description && (
          <p className="mt-4 text-base whitespace-pre-wrap text-zinc-600">
            {resource.description}
          </p>
        )}
      </header>

      <div className="mt-8">
        <ResourceGateForm
          brand={brand}
          slug={resource.slug}
          consentText={MARKETING_CONSENT_TEXT}
        />
      </div>
    </main>
  );
}
