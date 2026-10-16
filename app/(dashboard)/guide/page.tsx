"use client";

/**
 * The guide.
 *
 * Everything an operator needs in order to drive this stack, in the order the
 * dependencies actually run. The ordering is the point: Harvey is last, not
 * because it is hardest, but because without a handoff to send people to and
 * without consented addresses to write to, it has nothing to do.
 *
 * Setup steps and limits come from the registry rather than being typed again
 * here, so the guide cannot drift from the product. The live state chip next to
 * each section is the honest answer to "where am I" — no faked per-step
 * checkmarks, because nothing in the database can tell us whether somebody
 * pasted two keys into a file on their own Mac.
 */

import Link from "next/link";
import { SYSTEMS, type SystemId } from "@/lib/systems/registry";
import { StatusChip, useSystemStatus } from "@/components/system-status";

/** Why this order: each system is worth less until the one before it works. */
const JOURNEY: { id: SystemId; why: string }[] = [
  {
    id: "platform",
    why: "You are already here. Invite anyone else who will approve things, and look at diagnostics once while everything works so you know what healthy looks like.",
  },
  {
    id: "instagram",
    why: "Start here even if cold email is the goal. It is the only system whose whole loop you can test in two minutes, and it proves your webhook and worker are alive.",
  },
  {
    id: "whatsapp",
    why: "Next, because it is where everything else sends people. Until a number is connected, every tracked link in both channels points at a dead end.",
  },
  {
    id: "resources",
    why: "Then this, because it is the only honest way to get an email address. An Instagram commenter never gives you one; someone who wants your checklist does.",
  },
  {
    id: "harvey",
    why: "Last. Harvey needs a handoff to point at and addresses to write to, and both come from the two systems above.",
  },
];

/** When things happen. The most common misreading of this stack is expecting a
 *  decision to take effect instantly, so the slow paths are named explicitly. */
const TIMINGS: { event: string; speed: string; detail: string }[] = [
  {
    event: "Someone comments your keyword",
    speed: "Seconds",
    detail:
      "Meta's webhook hits Vercel, the DM is queued on Redis, the Railway worker sends it. If the worker is down the DM queues rather than vanishes, but it arrives late.",
  },
  {
    event: "Someone clicks a tracked link",
    speed: "Immediate",
    detail:
      "The click is recorded before the redirect returns. For a cold-email link it also becomes an engagement event Harvey can read.",
  },
  {
    event: "Someone opens the WhatsApp chat",
    speed: "Seconds",
    detail:
      "OpenWA posts the inbound message to this app, which reads the ref marker out of their first message and attributes the lead.",
  },
  {
    event: "Someone claims a resource",
    speed: "Immediate, then one sync",
    detail:
      "The link is shown and emailed at once. If they ticked consent, the lead is offered to Harvey on its next sync — about a minute.",
  },
  {
    event: "You approve or reject an email",
    speed: "About a minute to collect, up to 15 to act",
    detail:
      "The decision is queued here and Harvey collects it on its next bridge sync, every 60 seconds. It only sends on its next work heartbeat, which is every 15 minutes — so an approval is picked up quickly and acted on shortly after.",
  },
  {
    event: "Harvey checks in",
    speed: "Every 60 seconds while your Mac is awake",
    detail:
      "Nothing listens on your Mac. Harvey pushes what it learned and polls for what you decided. A sleeping laptop looks identical to a crashed one, which is why the agent card shows when it last spoke.",
  },
  {
    event: "Instagram tokens refresh",
    speed: "Daily, 05:00 UTC",
    detail:
      "A Vercel cron. A token that Meta rejected early still shows as an error on account health rather than waiting for the next run.",
  },
  {
    event: "Follower counts snapshot",
    speed: "Daily, 07:00 UTC",
    detail: "A Vercel cron, feeding the trend chart on account health.",
  },
];

/** The words that recur and mean something specific here. */
const GLOSSARY: { term: string; meaning: string }[] = [
  {
    term: "Tracked link",
    meaning:
      "A short /r/<slug> URL on this domain. It records the click, then redirects. It is the only way a click in one channel can be tied to a chat in another.",
  },
  {
    term: "Ref marker",
    meaning:
      "The (ref: <slug>) text pre-filled into a WhatsApp message. The inbound webhook reads it back to attribute the chat. If the customer deletes it the chat still arrives, just unattributed.",
  },
  {
    term: "Handoff",
    meaning:
      "Where a tracked link sends people — a WhatsApp number with a pre-filled message, or a booking page. Set per campaign for Instagram, once per agent for Harvey. It is held on the agent rather than taken from the request, so a compromised agent cannot repoint your links.",
  },
  {
    term: "Agent",
    meaning:
      "One brand's Harvey credential: an id and a secret your Mac uses to sign every request. The secret is shown once and stored encrypted, so nobody — including you — can read it back.",
  },
  {
    term: "Bridge sync",
    meaning:
      "One signed request every 60 seconds carrying everything at once: what Harvey learned, which decisions it has applied, and what it should collect. Outbound only.",
  },
  {
    term: "Work heartbeat",
    meaning:
      "Harvey's own 15-minute cycle, where it discovers companies, writes drafts and sends approved email. Separate from the bridge sync, and the reason an approval takes minutes rather than seconds to go out.",
  },
  {
    term: "Consent",
    meaning:
      "A lead reaches Harvey only if they ticked the box, the delivery email was accepted, and they have not been exported before. The exact sentence they agreed to is stored verbatim, because consent you cannot quote is not consent.",
  },
  {
    term: "Signal code",
    meaning:
      "Harvey's governed vocabulary for facts about a prospect. Every fact is a row, never a column, and a code has to be confirmed before Harvey will collect against it.",
  },
];

export default function GuidePage() {
  const { byId } = useSystemStatus();

  return (
    <div className="space-y-8">
      <header className="space-y-3">
        <h1 className="text-xl font-semibold">
          What works where, when and how
        </h1>
        <p className="max-w-3xl text-sm text-muted">
          Five systems, three machines, one database. Two of the systems do not
          run on Vercel at all and cannot, which is the single fact that
          explains most of this stack&apos;s shape. Work down this page in order
          — each system is worth less until the one before it works.
        </p>
        <p className="max-w-3xl text-sm text-muted">
          The{" "}
          <Link
            href="/systems"
            className="font-medium text-accent-hover hover:underline"
          >
            systems map
          </Link>{" "}
          shows the same five systems with live state and the files each one
          owns.
        </p>
      </header>

      <section className="rounded border border-border bg-surface p-4 sm:p-5">
        <h2 className="text-sm font-semibold">The order to do this in</h2>
        <ol className="mt-3 space-y-3">
          {JOURNEY.map((step, index) => {
            const system = SYSTEMS[step.id];
            const status = byId[step.id];
            return (
              <li key={step.id} className="flex gap-3">
                <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border bg-background text-xs font-semibold tabular-nums">
                  {index + 1}
                </span>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link
                      href={`#${system.id}`}
                      className="text-sm font-medium hover:underline"
                    >
                      {system.name}
                    </Link>
                    {status && <StatusChip state={status.state} />}
                  </div>
                  <p className="mt-1 text-sm text-muted">{step.why}</p>
                </div>
              </li>
            );
          })}
        </ol>
      </section>

      {JOURNEY.map(({ id }) => {
        const system = SYSTEMS[id];
        const status = byId[id];
        return (
          <section
            key={id}
            id={id}
            className="scroll-mt-24 rounded border border-border bg-surface"
          >
            <div className="border-b border-border p-4 sm:p-5">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-base font-semibold">{system.name}</h2>
                {status && <StatusChip state={status.state} />}
              </div>
              <p className="mt-2 text-sm">{system.tagline}</p>
              <p className="mt-2 text-sm text-muted">
                <span className="font-medium text-foreground">Runs on</span>{" "}
                {system.runtime.label} — {system.runtime.detail}
              </p>
              {status?.nextStep?.href && (
                <Link
                  href={status.nextStep.href}
                  className="mt-3 inline-block rounded bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-hover"
                >
                  {status.nextStep.label}
                </Link>
              )}
            </div>

            <div className="space-y-5 p-4 sm:p-5">
              <div>
                <h3 className="text-sm font-semibold">
                  Getting it working, in order
                </h3>
                <ol className="mt-2 space-y-2.5">
                  {system.setup.map((step, index) => (
                    <li key={step.title} className="flex gap-3">
                      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border border-border bg-background text-[11px] font-semibold tabular-nums text-muted">
                        {index + 1}
                      </span>
                      <div className="min-w-0">
                        <p className="text-sm font-medium">
                          {step.title}
                          {step.manual && (
                            <span className="ml-2 rounded border border-border bg-background px-1.5 py-0.5 text-[11px] font-normal text-muted">
                              only you can do this
                            </span>
                          )}
                        </p>
                        <p className="mt-0.5 text-sm text-muted">
                          {step.detail}
                        </p>
                        {step.href && (
                          <Link
                            href={step.href}
                            className="mt-1 inline-block text-sm font-medium text-accent-hover hover:underline"
                          >
                            Go there
                          </Link>
                        )}
                      </div>
                    </li>
                  ))}
                </ol>
              </div>

              {system.pages.length > 0 && (
                <div>
                  <h3 className="text-sm font-semibold">
                    Where to do what, once it works
                  </h3>
                  <dl className="mt-2 space-y-2">
                    {system.pages.map((page) => (
                      <div
                        key={page.href}
                        className="rounded border border-border bg-background p-3"
                      >
                        <dt>
                          <Link
                            href={page.href}
                            className="text-sm font-medium hover:underline"
                          >
                            {page.label}
                          </Link>
                        </dt>
                        <dd className="mt-0.5 text-sm text-muted">
                          {page.purpose}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </div>
              )}

              <div>
                <h3 className="text-sm font-semibold">
                  What it cannot do, so you stop waiting for it
                </h3>
                <ul className="mt-2 space-y-1.5">
                  {system.limits.map((limit) => (
                    <li key={limit} className="text-sm text-muted">
                      — {limit}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </section>
        );
      })}

      <section id="timing" className="scroll-mt-24 rounded border border-border bg-surface p-4 sm:p-5">
        <h2 className="text-sm font-semibold">When things actually happen</h2>
        <p className="mt-1 text-sm text-muted">
          The most common misreading of this stack is expecting a decision to
          take effect the moment you tap it.
        </p>
        <div className="mt-4 space-y-2.5">
          {TIMINGS.map((row) => (
            <div
              key={row.event}
              className="rounded border border-border bg-background p-3"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-sm font-medium">{row.event}</p>
                <p className="text-sm font-medium text-accent-hover">
                  {row.speed}
                </p>
              </div>
              <p className="mt-1 text-sm text-muted">{row.detail}</p>
            </div>
          ))}
        </div>
      </section>

      <section id="glossary" className="scroll-mt-24 rounded border border-border bg-surface p-4 sm:p-5">
        <h2 className="text-sm font-semibold">
          Words that mean something specific here
        </h2>
        <dl className="mt-4 space-y-3">
          {GLOSSARY.map((entry) => (
            <div key={entry.term}>
              <dt className="text-sm font-medium">{entry.term}</dt>
              <dd className="mt-0.5 text-sm text-muted">{entry.meaning}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="rounded border border-border bg-surface p-4 sm:p-5">
        <h2 className="text-sm font-semibold">When something looks wrong</h2>
        <ul className="mt-3 space-y-2.5 text-sm text-muted">
          <li>
            <span className="font-medium text-foreground">
              A system shows &ldquo;Needs you&rdquo;
            </span>{" "}
            — the{" "}
            <Link href="/systems" className="text-accent-hover hover:underline">
              systems map
            </Link>{" "}
            says exactly what and gives you the button for it.
          </li>
          <li>
            <span className="font-medium text-foreground">
              DMs stopped arriving
            </span>{" "}
            — check account health for a dead session, then{" "}
            <Link
              href="/diagnostics"
              className="text-accent-hover hover:underline"
            >
              diagnostics
            </Link>{" "}
            for queue depth and the worker heartbeat. A queue that is growing
            means the worker is down, not that Meta changed something.
          </li>
          <li>
            <span className="font-medium text-foreground">
              Harvey went quiet
            </span>{" "}
            — almost always a sleeping Mac. The agent card shows when it last
            checked in; anything over an hour means the process is not running.
          </li>
          <li>
            <span className="font-medium text-foreground">
              A chat arrived with no campaign attached
            </span>{" "}
            — the customer cleared the pre-filled text before sending. The lead
            is real, the attribution is gone, and there is no way to recover it
            after the fact.
          </li>
        </ul>
      </section>
    </div>
  );
}
