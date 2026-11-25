"use client";

/**
 * The systems map.
 *
 * This page answers the question the old sidebar could not: what is actually
 * running here, where does each piece run, and what joins them. Five systems
 * share one Next.js app and one Postgres database, and four of the five were
 * fused in after the fork — none of which was visible anywhere in the product.
 *
 * Each system gets a container of its own: its live state, the machine it runs
 * on, the database models and routes it owns, its pages, and what it genuinely
 * cannot do. The "owns" block is the honest answer to "show me where this was
 * dissolved into OpenReply" — it names the files and tables, so the claim can
 * be checked rather than taken on faith.
 */

import Link from "next/link";
import { useState } from "react";
import {
  listSystems,
  SYSTEMS,
  SYSTEM_FLOWS,
  type Runtime,
  type SystemDefinition,
} from "@/lib/systems/registry";
import {
  StatusChip,
  StatusDot,
  useSystemStatus,
} from "@/components/system-status";
import type { SystemStatus } from "@/lib/systems/status";

/** Where code runs, grouped the way an operator has to think about it: three
 *  machines, each with its own failure mode. */
const RUNTIME_GROUPS: {
  kind: Runtime;
  title: string;
  detail: string;
}[] = [
  {
    kind: "vercel",
    title: "Vercel",
    detail:
      "Serverless functions. Always available, never long-running — nothing here can hold a session or loop.",
  },
  {
    kind: "worker",
    title: "Long-lived services",
    detail:
      "The Railway DM worker and the OpenWA container. These remember what they did a minute ago, which is why rate limits and WhatsApp sessions live here.",
  },
  {
    kind: "local",
    title: "Your Mac",
    detail:
      "Harvey only. Its model backend is your logged-in Claude Code CLI, and that session cannot be carried to a server.",
  },
];

function OriginBadge({ origin }: { origin: SystemDefinition["origin"] }) {
  return origin === "fused" ? (
    <span className="rounded border border-accent/30 bg-accent/10 px-1.5 py-0.5 text-[11px] font-medium text-accent-hover">
      Fused in here
    </span>
  ) : (
    <span className="rounded border border-border bg-surface px-1.5 py-0.5 text-[11px] font-medium text-muted">
      Came with the fork
    </span>
  );
}

function OwnsBlock({ system }: { system: SystemDefinition }) {
  const rows: { label: string; items: string[] }[] = [
    { label: "Database models", items: system.owns.models },
    { label: "Routes", items: system.owns.routes },
    { label: "Code", items: system.owns.libs },
  ];
  return (
    <dl className="space-y-2.5">
      {rows.map((row) => (
        <div key={row.label}>
          <dt className="text-xs font-medium text-muted">{row.label}</dt>
          <dd className="mt-1 flex flex-wrap gap-1">
            {row.items.map((item) => (
              <code
                key={item}
                className="rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[11px] text-foreground"
              >
                {item}
              </code>
            ))}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function SystemCard({
  system,
  status,
}: {
  system: SystemDefinition;
  status: SystemStatus | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  const pages = system.pages.filter((page) => !page.hiddenInNav);

  return (
    // scroll-mt so landing on /systems#harvey from the sidebar does not tuck
    // the card's heading underneath the sticky top bar.
    <section
      id={system.id}
      className="scroll-mt-24 rounded border border-border bg-surface"
    >
      <div className="border-b border-border p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-base font-semibold">{system.name}</h2>
          {status ? (
            <StatusChip state={status.state} />
          ) : (
            <span className="text-xs text-muted">checking…</span>
          )}
          <span className="ml-auto">
            <OriginBadge origin={system.origin} />
          </span>
        </div>

        <p className="mt-2 text-sm text-foreground">{system.tagline}</p>

        {status && (
          <p className="mt-2 text-sm text-muted">{status.summary}</p>
        )}

        {status?.nextStep && (
          <div className="mt-3">
            {status.nextStep.href ? (
              <Link
                href={status.nextStep.href}
                className="inline-block rounded bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-hover"
              >
                {status.nextStep.label}
              </Link>
            ) : (
              <span className="text-sm text-muted">
                {status.nextStep.label}
              </span>
            )}
          </div>
        )}
      </div>

      {status && status.metrics.length > 0 && (
        <div className="grid grid-cols-2 gap-px border-b border-border bg-border sm:grid-cols-4">
          {status.metrics.map((metric) => (
            <div key={metric.label} className="bg-surface px-4 py-3">
              <p className="text-lg font-semibold tabular-nums">
                {metric.value}
              </p>
              <p className="text-xs text-muted">{metric.label}</p>
            </div>
          ))}
        </div>
      )}

      <div className="space-y-4 p-4 sm:p-5">
        <div>
          <p className="text-xs font-medium text-muted">Runs on</p>
          <p className="mt-0.5 text-sm font-medium">{system.runtime.label}</p>
          <p className="mt-1 text-sm text-muted">{system.runtime.detail}</p>
        </div>

        {pages.length > 0 && (
          <div>
            <p className="text-xs font-medium text-muted">Pages</p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {pages.map((page) => (
                <Link
                  key={page.href}
                  href={page.href}
                  title={page.purpose}
                  className="rounded border border-border bg-background px-2 py-1 text-sm text-muted hover:border-border-hover hover:text-foreground"
                >
                  {page.label}
                </Link>
              ))}
            </div>
          </div>
        )}

        <button
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          className="text-sm font-medium text-accent-hover hover:underline"
        >
          {expanded
            ? "Hide where this lives in the code"
            : "Show where this lives in the code"}
        </button>

        {expanded && (
          <div className="space-y-4 rounded border border-border bg-background p-4">
            <OwnsBlock system={system} />
            <div>
              <p className="text-xs font-medium text-muted">
                What it cannot do
              </p>
              <ul className="mt-1.5 space-y-1.5">
                {system.limits.map((limit) => (
                  <li key={limit} className="text-sm text-muted">
                    — {limit}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

export default function SystemsPage() {
  const { byId, loading, error, refresh } = useSystemStatus();
  const systems = listSystems();

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <h1 className="text-xl font-semibold">What is running here</h1>
        <p className="max-w-3xl text-sm text-muted">
          Five systems share one Next.js app and one Postgres database. One came
          with the open-source project this is forked from; four were fused in
          afterwards. They share a database on purpose — tracing a cold email
          click through to a WhatsApp chat is a join, and splitting the database
          would break the only thing the fusion is for.
        </p>
        {error && (
          <p className="text-sm text-error">
            {error}.{" "}
            <button onClick={refresh} className="underline">
              Try again
            </button>
          </p>
        )}
      </header>

      <section className="rounded border border-border bg-surface p-4 sm:p-5">
        <h2 className="text-sm font-semibold">Three machines</h2>
        <p className="mt-1 text-sm text-muted">
          Each has its own way of failing, which is the only reason an operator
          needs to care where a system runs.
        </p>
        <div className="mt-4 grid gap-px overflow-hidden rounded border border-border bg-border lg:grid-cols-3">
          {RUNTIME_GROUPS.map((group) => {
            const members = systems.filter(
              (system) => system.runtime.kind === group.kind
            );
            return (
              <div key={group.kind} className="bg-background p-4">
                <p className="text-sm font-semibold">{group.title}</p>
                <p className="mt-1 text-xs text-muted">{group.detail}</p>
                <div className="mt-3 space-y-1.5">
                  {members.map((system) => {
                    const status = byId[system.id];
                    return (
                      <Link
                        key={system.id}
                        href={`#${system.id}`}
                        className="flex items-center gap-2 text-sm text-muted hover:text-foreground"
                      >
                        <StatusDot state={status?.state ?? null} />
                        {system.name}
                      </Link>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="rounded border border-border bg-surface p-4 sm:p-5">
        <h2 className="text-sm font-semibold">What flows between them</h2>
        <p className="mt-1 text-sm text-muted">
          The half of the architecture the file layout cannot show: five
          specific hand-offs between systems that otherwise look independent.
        </p>
        <ol className="mt-4 space-y-3">
          {SYSTEM_FLOWS.map((flow) => (
            <li
              key={`${flow.from}-${flow.to}-${flow.label}`}
              className="rounded border border-border bg-background p-3"
            >
              <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                <Link href={`#${flow.from}`} className="hover:underline">
                  {SYSTEMS[flow.from].name}
                </Link>
                <span aria-hidden className="text-muted">
                  →
                </span>
                <Link href={`#${flow.to}`} className="hover:underline">
                  {SYSTEMS[flow.to].name}
                </Link>
              </div>
              <p className="mt-1 text-sm">{flow.label}</p>
              <p className="mt-1 text-xs text-muted">{flow.mechanism}</p>
            </li>
          ))}
        </ol>
      </section>

      <div className="space-y-5">
        {systems.map((system) => (
          <SystemCard
            key={system.id}
            system={system}
            status={byId[system.id]}
          />
        ))}
      </div>

      {loading && (
        <p className="text-sm text-muted">Reading live status…</p>
      )}

      <p className="text-sm text-muted">
        New here?{" "}
        <Link href="/guide" className="font-medium text-accent-hover hover:underline">
          The guide
        </Link>{" "}
        walks each system from nothing to working, in order.
      </p>
    </div>
  );
}
