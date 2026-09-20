"use client";

/**
 * The Meta app walkthrough.
 *
 * Every URL Meta asks for is derived from the live configuration and rendered
 * as a copy target. Step completion is tracked locally — it is a checklist for
 * a human working in another browser tab, not application state.
 */

import { useSyncExternalStore } from "react";
import { Callout, CopyField, Panel, StatusDot } from "@/components/setup/ui";
import type { SetupState } from "@/components/setup/types";

const STORAGE_KEY = "openreply.setup.meta-steps";

type Checklist = Record<string, boolean>;

const EMPTY: Checklist = {};

/**
 * The checklist lives in localStorage, which makes it an external store rather
 * than React state — so it is read through `useSyncExternalStore` instead of
 * being copied into state by an effect. The snapshot is cached because
 * `getSnapshot` has to return a referentially stable value between changes or
 * React will re-render forever.
 */
let cachedRaw: string | null = null;
let cachedValue: Checklist = EMPTY;
const listeners = new Set<() => void>();

function getSnapshot(): Checklist {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    // Blocked storage (private mode, disabled cookies) reads as an empty list.
    return EMPTY;
  }

  if (raw !== cachedRaw) {
    cachedRaw = raw;
    try {
      cachedValue = raw ? (JSON.parse(raw) as Checklist) : EMPTY;
    } catch {
      cachedValue = EMPTY;
    }
  }
  return cachedValue;
}

/** Nothing is checked during SSR; there is no storage to read from. */
function getServerSnapshot(): Checklist {
  return EMPTY;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Another tab editing the same checklist should be reflected here.
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

function writeChecklist(next: Checklist) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Non-fatal; the checklist simply will not persist across reloads.
  }
  for (const listener of listeners) listener();
}

export default function MetaPanel({ state }: { state: SetupState }) {
  const { metaWizard } = state;
  const done = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  function toggle(id: string) {
    writeChecklist({ ...done, [id]: !done[id] });
  }

  const webhookCheck = state.readiness.checks.find((check) => check.id === "webhook");
  const completed = metaWizard.steps.filter((step) => done[step.id]).length;

  return (
    <div className="space-y-6">
      <Panel
        title="Meta app setup"
        description="The code side of OpenReply is done in minutes; this is the part that takes an afternoon. Every value below is generated from your current configuration — copy them, do not retype them."
      >
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-muted">
          <span>
            {completed} of {metaWizard.steps.length} steps marked done
          </span>
          <span>
            Building URLs from{" "}
            <span className="font-mono text-xs text-foreground">
              {metaWizard.baseUrl}
            </span>
          </span>
        </div>

        {metaWizard.isLocal && (
          <div className="mt-4">
            <Callout tone="warn" title="These URLs point at localhost">
              <p>
                Meta cannot deliver webhooks to your machine. You can do
                everything else first, but before Instagram will send you
                comments, expose this instance with a tunnel and set{" "}
                <span className="font-mono text-xs">NEXTAUTH_URL</span> to the
                tunnel URL on the Environment tab. Every value on this tab
                updates to match.
              </p>
            </Callout>
          </div>
        )}

        {webhookCheck && (
          <div className="mt-4">
            <Callout
              tone={webhookCheck.status === "ok" ? "success" : "warn"}
              title="Webhook handshake self-test"
            >
              <p>{webhookCheck.detail}</p>
              {webhookCheck.remedy && <p className="mt-1">{webhookCheck.remedy}</p>}
              <p className="mt-1">
                This performs the exact request Meta&apos;s &ldquo;Verify and
                save&rdquo; button makes, so a pass here means a pass there.
              </p>
            </Callout>
          </div>
        )}
      </Panel>

      {metaWizard.steps.map((step, index) => (
        <Panel key={step.id}>
          <div className="flex items-start gap-4">
            <label className="flex cursor-pointer items-center gap-3 pt-0.5">
              <input
                type="checkbox"
                checked={Boolean(done[step.id])}
                onChange={() => toggle(step.id)}
                className="h-4 w-4 accent-[var(--color-accent)]"
                aria-label={`Mark "${step.title}" done`}
              />
            </label>

            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <h2
                  className={`text-base font-semibold ${
                    done[step.id] ? "text-muted line-through" : "text-foreground"
                  }`}
                >
                  {index + 1}. {step.title}
                </h2>
                <span className="text-xs text-muted">{step.where}</span>
              </div>

              <ul className="mt-3 space-y-2">
                {step.instructions.map((instruction) => (
                  <li key={instruction} className="flex gap-2 text-sm text-muted">
                    <StatusDot status="skipped" className="mt-1.5" />
                    <span>{instruction}</span>
                  </li>
                ))}
              </ul>

              {step.warning && (
                <div className="mt-4">
                  <Callout tone="warn">{step.warning}</Callout>
                </div>
              )}

              {step.values && step.values.length > 0 && (
                <div className="mt-4 space-y-4">
                  {step.values.map((value) => (
                    <CopyField
                      key={value.label}
                      label={value.label}
                      value={value.value}
                      note={
                        value.note
                          ? `${value.destination} — ${value.note}`
                          : value.destination
                      }
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
        </Panel>
      ))}
    </div>
  );
}
