/**
 * /setup — the Setup Console.
 *
 * The gate is evaluated on the server before anything renders, so a closed
 * console never ships the client bundle, let alone any configuration. A denial
 * explains what to change rather than 404-ing silently, because the person
 * hitting this URL is almost always the operator.
 */

import type { Metadata } from "next";
import SetupConsole from "@/components/setup/setup-console";
import { evaluateSetupAccess } from "@/lib/setup/guard";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Setup Console — OpenReply",
  description: "Configure, verify, and point your OpenReply instance.",
  robots: { index: false, follow: false },
};

export default async function SetupPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  const access = evaluateSetupAccess({ presentedToken: token ?? null });

  if (!access.allowed) {
    return (
      <div className="mx-auto max-w-xl px-6 py-24">
        <h1 className="text-2xl font-bold text-foreground">
          Setup Console unavailable
        </h1>
        <p className="mt-3 text-sm text-muted">{access.message}</p>

        {access.tokenRequired && (
          <p className="mt-4 text-sm text-muted">
            Append{" "}
            <span className="font-mono text-xs text-foreground">
              ?token=YOUR_SETUP_CONSOLE_TOKEN
            </span>{" "}
            to this URL.
          </p>
        )}

        <p className="mt-8 text-sm text-muted">
          The console can write <span className="font-mono text-xs">.env</span>,
          reveal secrets, and create a signed-in session without a password.
          Those are the right powers on a machine you control and the wrong ones
          on a public deployment, which is why it is closed here by default.
        </p>

        <a
          href="/dashboard"
          className="mt-8 inline-block text-sm font-semibold text-accent hover:text-accent-hover"
        >
          Go to the dashboard →
        </a>
      </div>
    );
  }

  return <SetupConsole token={token ?? null} />;
}
