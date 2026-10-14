"use client";

/**
 * Resources
 *
 * The lead magnets behind the public hub, and the addresses they bring in.
 *
 * Two counts per resource, never one: how many people took it, and how many of
 * those agreed to hear more. Only the second number can ever be emailed, and
 * showing them apart is what keeps that distinction obvious.
 */

import { useCallback, useEffect, useState } from "react";

interface Resource {
  id: string;
  slug: string;
  title: string;
  summary: string;
  description: string | null;
  destinationUrl: string;
  kind: string | null;
  isPublished: boolean;
  leadCount: number;
  consentedCount: number;
}

interface Brand {
  name: string;
  publicSlug: string | null;
}

export default function ResourcesPage() {
  const [brand, setBrand] = useState<Brand | null>(null);
  const [resources, setResources] = useState<Resource[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [slugDraft, setSlugDraft] = useState("");
  const [form, setForm] = useState({
    slug: "",
    title: "",
    summary: "",
    description: "",
    destinationUrl: "",
    kind: "",
  });
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      const json = await (await fetch("/api/outreach/resources")).json();
      if (json.success) {
        setBrand(json.data.workspace);
        setResources(json.data.resources);
        setSlugDraft((current) => current || (json.data.workspace?.publicSlug ?? ""));
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function saveBrandSlug() {
    setError(null);
    const response = await fetch("/api/outreach/brand", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ publicSlug: slugDraft.trim() }),
    });
    const json = await response.json();
    if (!json.success) {
      setError(json.error ?? "Could not save that address.");
      return;
    }
    await load();
  }

  async function createResource(event: React.FormEvent) {
    event.preventDefault();
    setCreating(true);
    setError(null);
    try {
      const response = await fetch("/api/outreach/resources", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug: form.slug.trim(),
          title: form.title.trim(),
          summary: form.summary.trim(),
          description: form.description.trim() || undefined,
          destinationUrl: form.destinationUrl.trim(),
          kind: form.kind.trim() || undefined,
        }),
      });
      const json = await response.json();
      if (!json.success) {
        setError(json.issues?.[0]?.message ?? json.error ?? "Could not add that.");
        return;
      }
      setForm({ slug: "", title: "", summary: "", description: "", destinationUrl: "", kind: "" });
      await load();
    } finally {
      setCreating(false);
    }
  }

  async function togglePublished(resource: Resource) {
    setBusyId(resource.id);
    setError(null);
    try {
      const response = await fetch("/api/outreach/resources", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: resource.id, isPublished: !resource.isPublished }),
      });
      const json = await response.json();
      if (!json.success) {
        setError(json.error ?? "Could not change that.");
        return;
      }
      await load();
    } finally {
      setBusyId(null);
    }
  }

  const hubUrl = brand?.publicSlug ? `/resources/${brand.publicSlug}` : null;
  const totalConsented = resources.reduce((sum, r) => sum + r.consentedCount, 0);
  const totalLeads = resources.reduce((sum, r) => sum + r.leadCount, 0);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-xl font-semibold">Resources</h1>
        <p className="text-sm text-zinc-500">
          One public page per brand, with an email gate on each thing you give
          away. It is where outbound gets its addresses.
        </p>
      </div>

      {error && (
        <div className="panel rounded border-l-2 border-l-red-500 p-4 text-sm">{error}</div>
      )}

      <section className="panel rounded p-4 sm:p-6">
        <h2 className="text-base font-semibold">Public address</h2>
        <p className="mt-1 text-xs text-zinc-500">
          The brand part of every resource link you share. Changing it breaks
          links you have already put out, so pick it once.
        </p>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
          <span className="text-sm text-zinc-500">/resources/</span>
          <input
            value={slugDraft}
            onChange={(event) => setSlugDraft(event.target.value)}
            placeholder="vantik"
            className="w-full rounded border border-border bg-transparent px-3 py-2 text-sm sm:w-56"
          />
          <button
            type="button"
            onClick={() => void saveBrandSlug()}
            disabled={slugDraft.trim().length < 2}
            className="w-full rounded border border-border px-4 py-2 text-sm disabled:opacity-50 sm:w-auto"
          >
            Save
          </button>
        </div>
        {hubUrl && (
          <p className="mt-3 text-sm">
            Live at{" "}
            <a href={hubUrl} target="_blank" rel="noopener noreferrer" className="underline">
              {hubUrl}
            </a>
          </p>
        )}
      </section>

      <section className="panel rounded p-4 sm:p-6">
        <div className="mb-1 flex items-baseline justify-between gap-4">
          <h2 className="text-base font-semibold">Published and drafts</h2>
          <span className="text-xs text-zinc-500">
            {totalLeads} downloads · {totalConsented} opted in
          </span>
        </div>

        {loading ? (
          <p className="mt-3 text-sm text-zinc-500">Loading…</p>
        ) : resources.length === 0 ? (
          <p className="mt-3 text-sm text-zinc-500">
            Nothing yet. Add your first resource below; a Google Drive link is
            fine.
          </p>
        ) : (
          <ul className="mt-4 space-y-3">
            {resources.map((resource) => (
              <li
                key={resource.id}
                className="flex flex-wrap items-start justify-between gap-3 border-t border-border pt-3 first:border-t-0 first:pt-0"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span
                      aria-hidden
                      className={`inline-block h-2 w-2 rounded-full ${
                        resource.isPublished ? "bg-emerald-500" : "bg-zinc-400"
                      }`}
                    />
                    <span className="font-medium">{resource.title}</span>
                    {resource.kind && (
                      <span className="text-xs text-zinc-500">{resource.kind}</span>
                    )}
                  </div>
                  <div className="mt-0.5 text-xs text-zinc-500">
                    /{resource.slug} · {resource.leadCount} downloads ·{" "}
                    {resource.consentedCount} opted in
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {resource.isPublished && hubUrl && (
                    <a
                      href={`${hubUrl}/${resource.slug}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-zinc-500 underline"
                    >
                      View
                    </a>
                  )}
                  <button
                    type="button"
                    disabled={busyId === resource.id}
                    onClick={() => void togglePublished(resource)}
                    className="rounded border border-border px-3 py-1.5 text-xs disabled:opacity-50"
                  >
                    {resource.isPublished ? "Unpublish" : "Publish"}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel rounded p-4 sm:p-6">
        <h2 className="text-base font-semibold">Add a resource</h2>
        <form onSubmit={createResource} className="mt-3 space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-sm">
              <span className="text-zinc-500">Title</span>
              <input
                required
                value={form.title}
                onChange={(event) => setForm({ ...form, title: event.target.value })}
                placeholder="The Wholesale Checklist"
                className="mt-1 w-full rounded border border-border bg-transparent px-3 py-2 text-sm"
              />
            </label>
            <label className="block text-sm">
              <span className="text-zinc-500">Address</span>
              <input
                required
                value={form.slug}
                onChange={(event) => setForm({ ...form, slug: event.target.value })}
                placeholder="wholesale-checklist"
                className="mt-1 w-full rounded border border-border bg-transparent px-3 py-2 text-sm"
              />
            </label>
          </div>
          <label className="block text-sm">
            <span className="text-zinc-500">One line that earns the email</span>
            <input
              required
              value={form.summary}
              onChange={(event) => setForm({ ...form, summary: event.target.value })}
              placeholder="The 12 checks we run before taking on a wholesale order."
              className="mt-1 w-full rounded border border-border bg-transparent px-3 py-2 text-sm"
            />
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-sm">
              <span className="text-zinc-500">Link to the file</span>
              <input
                required
                value={form.destinationUrl}
                onChange={(event) => setForm({ ...form, destinationUrl: event.target.value })}
                placeholder="https://drive.google.com/…"
                className="mt-1 w-full rounded border border-border bg-transparent px-3 py-2 text-sm"
              />
            </label>
            <label className="block text-sm">
              <span className="text-zinc-500">Label (optional)</span>
              <input
                value={form.kind}
                onChange={(event) => setForm({ ...form, kind: event.target.value })}
                placeholder="Checklist"
                className="mt-1 w-full rounded border border-border bg-transparent px-3 py-2 text-sm"
              />
            </label>
          </div>
          <label className="block text-sm">
            <span className="text-zinc-500">Longer description (optional)</span>
            <textarea
              rows={3}
              value={form.description}
              onChange={(event) => setForm({ ...form, description: event.target.value })}
              className="mt-1 w-full rounded border border-border bg-transparent px-3 py-2 text-sm"
            />
          </label>
          <button
            type="submit"
            disabled={creating}
            className="w-full rounded bg-foreground px-4 py-2 text-sm font-medium text-background disabled:opacity-50 sm:w-auto"
          >
            {creating ? "Adding…" : "Add as draft"}
          </button>
          <p className="text-xs text-zinc-500">
            Everything starts unpublished. Publish when the page reads right.
          </p>
        </form>
      </section>
    </div>
  );
}
