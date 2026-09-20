"use client";

/**
 * The Setup Console shell.
 *
 * One snapshot endpoint feeds every tab, so the page is always internally
 * consistent: you never see a check that passed a minute ago sitting next to a
 * value you changed since. Every mutation refetches that snapshot rather than
 * patching local state, which keeps "what the server believes" and "what the
 * screen shows" the same thing.
 */

import { useCallback, useEffect, useState } from "react";
import EnvironmentPanel from "@/components/setup/environment-panel";
import MetaPanel from "@/components/setup/meta-panel";
import OverviewPanel from "@/components/setup/overview-panel";
import SignInPanel from "@/components/setup/signin-panel";
import TargetsPanel from "@/components/setup/targets-panel";
import { Button, Callout, StatusDot } from "@/components/setup/ui";
import type { CheckStatus, SetupState, TabId } from "@/components/setup/types";

const TABS: { id: TabId; label: string; blurb: string }[] = [
  { id: "overview", label: "Overview", blurb: "Readiness at a glance" },
  { id: "environment", label: "Environment", blurb: "Edit .env safely" },
  { id: "meta", label: "Meta app", blurb: "URLs to copy into Meta" },
  { id: "signin", label: "Sign in", blurb: "Get into the dashboard" },
  { id: "targets", label: "Targets", blurb: "Accounts, posts, keywords" },
];

export default function SetupConsole({ token }: { token: string | null }) {
  const [state, setState] = useState<SetupState | null>(null);
  const [tab, setTab] = useState<TabId>("overview");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /**
   * Every console call goes through here so the setup token (needed only when
   * the console has been opened in production) is attached in exactly one place.
   */
  const request = useCallback(
    async <T,>(path: string, init?: RequestInit): Promise<T> => {
      const response = await fetch(path, {
        ...init,
        headers: {
          "Content-Type": "application/json",
          ...(token ? { "x-setup-token": token } : {}),
          ...init?.headers,
        },
        cache: "no-store",
      });

      const payload = (await response.json().catch(() => null)) as T | null;
      if (payload === null) {
        throw new Error(`${response.status} ${response.statusText}`);
      }
      return payload;
    },
    [token]
  );

  type Snapshot = { success: boolean; error?: string; data?: SetupState };

  const applySnapshot = useCallback((payload: Snapshot) => {
    if (payload.success && payload.data) {
      setState(payload.data);
      setError(null);
    } else {
      setError(payload.error ?? "Could not load setup state");
    }
  }, []);

  const applyError = useCallback((fetchError: unknown) => {
    setError(
      fetchError instanceof Error
        ? fetchError.message
        : "Could not load setup state"
    );
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      applySnapshot(await request<Snapshot>("/api/setup/state"));
    } catch (fetchError) {
      applyError(fetchError);
    } finally {
      setLoading(false);
    }
  }, [request, applySnapshot, applyError]);

  // The initial fetch. `loading` already starts true, and every state update
  // happens inside a promise callback rather than in the effect body, so
  // nothing lands synchronously. A response that arrives after unmount, or
  // after `request` changes identity, is discarded.
  useEffect(() => {
    let active = true;
    request<Snapshot>("/api/setup/state")
      .then((payload) => {
        if (active) applySnapshot(payload);
      })
      .catch((fetchError: unknown) => {
        if (active) applyError(fetchError);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [request, applySnapshot, applyError]);

  if (!state) {
    return (
      <div className="mx-auto max-w-6xl px-6 py-16">
        {error ? (
          <Callout tone="error" title="Could not load the Setup Console">
            <p>{error}</p>
          </Callout>
        ) : (
          <p className="text-sm text-muted">Loading setup state…</p>
        )}
      </div>
    );
  }

  const tabStatus: Record<TabId, CheckStatus> = {
    overview: state.readiness.status,
    environment: worstOf(state, ["env"]),
    meta: worstOf(state, ["webhook", "reachability"]),
    signin: state.session ? "ok" : "warn",
    targets: state.targets.length > 0 ? "ok" : worstOf(state, ["instagram"]),
  };

  return (
    <div className="mx-auto max-w-6xl px-6 py-10">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold text-foreground">Setup Console</h1>
            <span className="rounded border border-border px-2 py-0.5 text-xs font-semibold text-muted">
              {state.environment}
            </span>
          </div>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            Configure this OpenReply instance, verify it end to end, and point it
            at the posts you want watched — without leaving the browser.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <a
            href="/dashboard"
            className="text-sm font-semibold text-accent hover:text-accent-hover"
          >
            Dashboard →
          </a>
          <Button onClick={() => void refresh()} disabled={loading}>
            {loading ? "Refreshing…" : "Refresh"}
          </Button>
        </div>
      </header>

      {error && (
        <div className="mt-6">
          <Callout tone="error">{error}</Callout>
        </div>
      )}

      <div className="mt-8 grid gap-8 lg:grid-cols-[220px_1fr]">
        <nav aria-label="Setup steps">
          <ul className="space-y-1">
            {TABS.map((entry) => {
              const active = entry.id === tab;
              return (
                <li key={entry.id}>
                  <button
                    type="button"
                    onClick={() => setTab(entry.id)}
                    aria-current={active ? "page" : undefined}
                    className={`flex w-full items-start gap-2.5 rounded border px-3 py-2.5 text-left transition ${
                      active
                        ? "border-accent bg-accent/10"
                        : "border-transparent hover:border-border"
                    }`}
                  >
                    <StatusDot status={tabStatus[entry.id]} className="mt-1.5" />
                    <span className="min-w-0">
                      <span
                        className={`block text-sm font-semibold ${
                          active ? "text-foreground" : "text-muted"
                        }`}
                      >
                        {entry.label}
                      </span>
                      <span className="mt-0.5 block text-xs text-muted">
                        {entry.blurb}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>

        <main>
          {tab === "overview" && (
            <OverviewPanel
              state={state}
              refreshing={loading}
              onRefresh={() => void refresh()}
              onNavigate={setTab}
            />
          )}
          {tab === "environment" && (
            <EnvironmentPanel
              state={state}
              request={request}
              onSaved={() => void refresh()}
            />
          )}
          {tab === "meta" && <MetaPanel state={state} />}
          {tab === "signin" && (
            <SignInPanel
              state={state}
              request={request}
              onChanged={() => void refresh()}
            />
          )}
          {tab === "targets" && (
            <TargetsPanel
              state={state}
              request={request}
              onChanged={() => void refresh()}
              onNavigate={setTab}
            />
          )}
        </main>
      </div>
    </div>
  );
}

const SEVERITY: Record<CheckStatus, number> = {
  ok: 0,
  skipped: 1,
  warn: 2,
  error: 3,
};

function worstOf(state: SetupState, checkIds: string[]): CheckStatus {
  return state.readiness.checks
    .filter((check) => checkIds.includes(check.id))
    .reduce<CheckStatus>(
      (worst, check) =>
        SEVERITY[check.status] > SEVERITY[worst] ? check.status : worst,
      "ok"
    );
}
