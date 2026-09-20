"use client";

/**
 * The readiness board: every check, what it found, and what to do about it.
 *
 * Ordered so the answer to "can this send a DM right now?" is the first thing
 * on the page, because that is the only question that matters during setup.
 */

import {
  Button,
  Callout,
  CodeLine,
  Panel,
  StatusDot,
  statusTextClass,
} from "@/components/setup/ui";
import type { SetupState, TabId } from "@/components/setup/types";

export default function OverviewPanel({
  state,
  refreshing,
  onRefresh,
  onNavigate,
}: {
  state: SetupState;
  refreshing: boolean;
  onRefresh: () => void;
  onNavigate: (tab: TabId) => void;
}) {
  const { readiness, envFile } = state;
  const okCount = readiness.checks.filter((check) => check.status === "ok").length;

  return (
    <div className="space-y-6">
      <Panel
        title={readiness.ready ? "Ready to send" : "Not ready yet"}
        description={
          readiness.ready
            ? "Comments matching an active target will be turned into DMs. The checks below cover the rest of the setup."
            : "These are the things standing between a matching comment and a delivered DM."
        }
        actions={
          <Button onClick={onRefresh} disabled={refreshing}>
            {refreshing ? "Checking…" : "Re-run checks"}
          </Button>
        }
      >
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
          <span className="flex items-center gap-2">
            <StatusDot status={readiness.status} />
            <span className={`font-semibold ${statusTextClass(readiness.status)}`}>
              {okCount} of {readiness.checks.length} checks passing
            </span>
          </span>
          <span className="text-muted">
            Config file: <span className="font-mono text-xs">{envFile.path}</span>
            {!envFile.exists && " (not created yet)"}
          </span>
        </div>

        {envFile.staleFields.length > 0 && (
          <div className="mt-4">
            <Callout tone="warn" title="Saved to disk, but not loaded">
              <p>
                {envFile.staleFields.join(", ")}{" "}
                {envFile.staleFields.length === 1 ? "differs" : "differ"} between{" "}
                <span className="font-mono text-xs">.env</span> and the running
                process. Restart the dev server so the app uses what you saved.
              </p>
              <div className="mt-2 max-w-md">
                <CodeLine>npm run dev</CodeLine>
              </div>
            </Callout>
          </div>
        )}
      </Panel>

      <Panel title="Checks">
        <ul className="divide-y divide-border">
          {readiness.checks.map((check) => (
            <li key={check.id} className="py-4 first:pt-0 last:pb-0">
              <div className="flex items-start gap-3">
                <StatusDot status={check.status} className="mt-1.5" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                    <p className="text-sm font-semibold text-foreground">
                      {check.label}
                    </p>
                    <p className={`text-xs font-semibold ${statusTextClass(check.status)}`}>
                      {check.status === "ok"
                        ? "Pass"
                        : check.status === "warn"
                          ? "Worth checking"
                          : check.status === "error"
                            ? "Blocked"
                            : "Skipped"}
                    </p>
                  </div>
                  <p className="mt-1 text-sm text-muted">{check.detail}</p>
                  {check.remedy && (
                    <p className="mt-2 text-sm text-foreground/80">{check.remedy}</p>
                  )}
                  {check.command && (
                    <div className="mt-2 max-w-md">
                      <CodeLine>{check.command}</CodeLine>
                    </div>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      </Panel>

      <Panel
        title="What to do next"
        description="The order that gets you from nothing to a delivered DM."
      >
        <ol className="space-y-3">
          {[
            {
              tab: "environment" as TabId,
              title: "Fill in the environment",
              body: "Generate the secrets, point at Postgres and Redis, add the Meta credentials.",
            },
            {
              tab: "meta" as TabId,
              title: "Set up the Meta app",
              body: "Copy the redirect and webhook URLs into Meta's console and subscribe to comments.",
            },
            {
              tab: "signin" as TabId,
              title: "Get into the dashboard",
              body: "Create a local session without waiting on Resend, or send yourself a magic link once Resend works.",
            },
            {
              tab: "targets" as TabId,
              title: "Connect Instagram and add targets",
              body: "Pick the post, set the keywords, write the DM. Add as many targets and accounts as you need.",
            },
          ].map((step, index) => (
            <li key={step.tab} className="flex gap-4">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border text-xs font-semibold text-muted">
                {index + 1}
              </span>
              <div>
                <button
                  type="button"
                  onClick={() => onNavigate(step.tab)}
                  className="text-sm font-semibold text-accent hover:text-accent-hover"
                >
                  {step.title}
                </button>
                <p className="mt-0.5 text-sm text-muted">{step.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </Panel>
    </div>
  );
}
