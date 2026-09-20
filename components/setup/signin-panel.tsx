"use client";

/**
 * Getting into the dashboard.
 *
 * Two ways in. The local one writes a session row directly and is the answer to
 * the chicken-and-egg problem of needing the dashboard to configure the email
 * service that the dashboard's login depends on. The normal one is the real
 * magic-link flow, offered once Resend actually works.
 */

import { useState } from "react";
import { Button, Callout, Field, Panel, inputClass } from "@/components/setup/ui";
import type { SetupState } from "@/components/setup/types";

export default function SignInPanel({
  state,
  request,
  onChanged,
}: {
  state: SetupState;
  request: <T>(path: string, init?: RequestInit) => Promise<T>;
  onChanged: () => void;
}) {
  const [email, setEmail] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const resendCheck = state.readiness.checks.find((check) => check.id === "resend");
  const resendReady = resendCheck?.status === "ok";

  async function signIn() {
    setBusy(true);
    setMessage(null);
    try {
      const payload = await request<{
        success: boolean;
        error?: string;
        data?: { email: string; workspaceName: string };
      }>("/api/setup/session", {
        method: "POST",
        body: JSON.stringify({
          email,
          workspaceName: workspaceName || undefined,
        }),
      });

      if (!payload.success) {
        setMessage({ ok: false, text: payload.error ?? "Could not sign in" });
        return;
      }

      setMessage({
        ok: true,
        text: `Signed in as ${payload.data?.email} in "${payload.data?.workspaceName}". The dashboard is open to you now.`,
      });
      onChanged();
    } catch (error) {
      setMessage({
        ok: false,
        text: error instanceof Error ? error.message : "Could not sign in",
      });
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    setBusy(true);
    setMessage(null);
    try {
      await request("/api/setup/session", { method: "DELETE" });
      setMessage({ ok: true, text: "Signed out." });
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <Panel
        title="Current session"
        description="The console can read and write configuration without a session, but connecting Instagram and browsing the dashboard need one."
        actions={
          state.session ? (
            <Button onClick={() => void signOut()} disabled={busy}>
              Sign out
            </Button>
          ) : undefined
        }
      >
        {state.session ? (
          <Callout tone="success">
            Signed in as{" "}
            <span className="font-semibold text-foreground">
              {state.session.email}
            </span>
            {state.workspace.name && (
              <>
                {" "}
                in workspace{" "}
                <span className="font-semibold text-foreground">
                  {state.workspace.name}
                </span>
              </>
            )}
            .{" "}
            <a
              href="/dashboard"
              className="font-semibold text-accent hover:text-accent-hover"
            >
              Open the dashboard →
            </a>
          </Callout>
        ) : (
          <Callout tone="warn">
            Not signed in.
            {state.workspace.message ? ` ${state.workspace.message}` : ""}
          </Callout>
        )}
      </Panel>

      <Panel
        title="Local sign-in"
        description="Creates the user, the workspace, and a session directly, with no email round-trip."
      >
        <Callout tone="warn" title="Why this exists, and when not to use it">
          <p>
            OpenReply signs people in with email magic links, which needs a
            working Resend key and a verified domain. Configuring that is one of
            the things you came here to do — so on a machine you control, the
            console skips the email and writes the session itself.
          </p>
          <p className="mt-2">
            It is authentication with no authentication, which is why it is
            disabled in production unless you deliberately open the console with
            a token. Use the magic-link flow for anyone who is not you.
          </p>
        </Callout>

        <div className="mt-5 grid gap-5 sm:grid-cols-2">
          <Field
            label="Email"
            htmlFor="signin-email"
            hint="Becomes your user account. It does not need to be deliverable."
          >
            <input
              id="signin-email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@yourdomain.com"
              className={inputClass}
            />
          </Field>

          <Field
            label="Workspace name (optional)"
            htmlFor="signin-workspace"
            hint="Defaults to a name derived from the email."
          >
            <input
              id="signin-workspace"
              value={workspaceName}
              onChange={(event) => setWorkspaceName(event.target.value)}
              placeholder="My workspace"
              className={inputClass}
            />
          </Field>
        </div>

        {message && (
          <div className="mt-5">
            <Callout tone={message.ok ? "success" : "error"}>{message.text}</Callout>
          </div>
        )}

        <div className="mt-5 flex justify-end">
          <Button
            variant="primary"
            onClick={() => void signIn()}
            disabled={busy || !email.trim()}
          >
            {busy ? "Signing in…" : "Sign in locally"}
          </Button>
        </div>
      </Panel>

      <Panel
        title="Magic-link sign-in"
        description="The real flow, and the only one available to anyone else."
      >
        {resendReady ? (
          <Callout tone="success">
            <p>{resendCheck?.detail}</p>
            <p className="mt-2">
              <a
                href="/login"
                className="font-semibold text-accent hover:text-accent-hover"
              >
                Go to the login page →
              </a>
            </p>
          </Callout>
        ) : (
          <Callout tone="warn">
            <p>{resendCheck?.detail ?? "Resend is not configured."}</p>
            {resendCheck?.remedy && <p className="mt-2">{resendCheck.remedy}</p>}
          </Callout>
        )}
      </Panel>
    </div>
  );
}
