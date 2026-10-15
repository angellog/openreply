"use client";

/**
 * The gate.
 *
 * Asks for an address, hands back the link in place. No redirect and no "check
 * your inbox and come back": the visitor gets what they came for immediately,
 * and the copy we email is a bonus that also proves the address is real.
 */

import { useState } from "react";

type Status = "idle" | "working" | "done" | "error";

export default function ResourceGateForm({
  brand,
  slug,
  consentText,
  buttonLabel = "Get the link",
}: {
  brand: string;
  slug: string;
  consentText: string;
  buttonLabel?: string;
}) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [consent, setConsent] = useState(false);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ url: string; emailed: boolean } | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setStatus("working");
    setError(null);

    try {
      const response = await fetch(`/api/resources/${brand}/${slug}/claim`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          name: name || undefined,
          consentMarketing: consent,
          // Set by the tracked link that sent them here, when there was one.
          ref: new URLSearchParams(window.location.search).get("ref") ?? undefined,
        }),
      });
      const json = await response.json();
      if (!json.success) {
        setError(json.error ?? "That did not go through. Try again.");
        setStatus("error");
        return;
      }
      setResult(json.data);
      setStatus("done");
    } catch {
      setError("Something went wrong. Try again.");
      setStatus("error");
    }
  }

  if (status === "done" && result) {
    return (
      <div className="rounded-lg border border-zinc-200 bg-white p-5 text-center">
        <p className="text-sm text-zinc-500">Here it is.</p>
        <a
          href={result.url}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-3 inline-block w-full rounded-md bg-zinc-900 px-5 py-3 text-base font-medium text-white"
        >
          Open it now
        </a>
        <p className="mt-3 text-xs text-zinc-500">
          {result.emailed
            ? "A copy is in your inbox too, so you can find it later."
            : "Save the link now. We could not email a copy."}
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="rounded-lg border border-zinc-200 bg-white p-5">
      <label htmlFor="resource-email" className="sr-only">
        Your email
      </label>
      <input
        id="resource-email"
        type="email"
        required
        autoComplete="email"
        inputMode="email"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        placeholder="you@company.com"
        className="w-full rounded-md border border-zinc-300 px-4 py-3 text-base outline-none focus:border-zinc-900"
      />

      <label htmlFor="resource-name" className="sr-only">
        Your name, optional
      </label>
      <input
        id="resource-name"
        type="text"
        autoComplete="name"
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder="Your name (optional)"
        className="mt-2 w-full rounded-md border border-zinc-300 px-4 py-3 text-base outline-none focus:border-zinc-900"
      />

      {/* Unticked by default, and never required. The resource is handed over
          either way, which is the only way a tick means anything. */}
      <label className="mt-3 flex cursor-pointer items-start gap-2 text-sm text-zinc-600">
        <input
          type="checkbox"
          checked={consent}
          onChange={(event) => setConsent(event.target.checked)}
          className="mt-0.5 h-4 w-4 shrink-0"
        />
        <span>{consentText}</span>
      </label>

      <button
        type="submit"
        disabled={status === "working"}
        className="mt-4 w-full rounded-md bg-zinc-900 px-5 py-3 text-base font-medium text-white disabled:opacity-60"
      >
        {status === "working" ? "One moment…" : buttonLabel}
      </button>

      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

      <p className="mt-3 text-xs text-zinc-500">
        We send you the link and nothing else unless you tick the box.
      </p>
    </form>
  );
}
