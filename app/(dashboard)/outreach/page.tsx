"use client";

/**
 * Outreach
 *
 * The decisions desk for outbound email. Harvey writes the cold emails on the
 * operator's own machine; nothing is sent until someone says yes here, which
 * is the point — the alternative is Harvey's dashboard on localhost, reachable
 * only from the machine it runs on.
 *
 * Built for a phone first. One email at a time, full-width buttons, and an
 * honest account of where each decision is: queued, collected by Harvey, or
 * sent.
 */

import { useCallback, useEffect, useState } from "react";

interface Agent {
  id: string;
  name: string;
  status: "ACTIVE" | "REVOKED";
  secretPrefix: string;
  whatsappPhone: string | null;
  defaultDestinationUrl: string | null;
  lastSeenAt: string | null;
  lastSyncAt: string | null;
  agentVersion: string | null;
  brainProvider: string | null;
  online: boolean;
  _count: { prospects: number; emails: number };
}

interface OutboxEmail {
  id: string;
  harveyId: string;
  subject: string;
  body: string;
  toEmail: string;
  step: number;
  kind: string;
  status: "PENDING_REVIEW" | "APPROVED" | "SENT" | "FAILED" | "CANCELLED";
  sentAt: string | null;
  error: string | null;
  createdAt: string;
  stale: boolean;
  trackedUrl: string | null;
  pendingDecision: {
    kind: "APPROVE_EMAIL" | "REJECT_EMAIL";
    issuedAt: string;
    deliveredAt: string | null;
  } | null;
  prospect: {
    firstName: string | null;
    lastName: string | null;
    title: string | null;
    score: number | null;
    emailStatus: string | null;
    personalizationNotes: string | null;
    company: { name: string; domain: string | null; location: string | null } | null;
  } | null;
}

/** How often to re-read while the page is open, so a decision stops saying
 *  "waiting for Harvey" within a heartbeat of Harvey collecting it. */
const POLL_MS = 15000;

function sinceText(value: string | null) {
  if (!value) return "never";
  const seconds = Math.round((Date.now() - new Date(value).getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function prospectName(email: OutboxEmail) {
  const name = [email.prospect?.firstName, email.prospect?.lastName]
    .filter(Boolean)
    .join(" ")
    .trim();
  return name || email.toEmail;
}

function statusLabel(email: OutboxEmail) {
  if (email.status === "SENT") return `Sent ${sinceText(email.sentAt)}`;
  if (email.status === "FAILED") return email.error ? `Failed: ${email.error}` : "Failed";
  if (email.status === "CANCELLED") return email.error ? `Stopped: ${email.error}` : "Stopped";
  if (email.status === "APPROVED") return "Approved — goes out on Harvey's next run";
  if (email.pendingDecision) {
    return email.pendingDecision.deliveredAt
      ? "Harvey picked this up"
      : "Saved — waiting for Harvey to pick it up";
  }
  return "Waiting for you";
}

export default function OutreachPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [emails, setEmails] = useState<OutboxEmail[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pairing, setPairing] = useState(false);
  const [newAgentName, setNewAgentName] = useState("");
  /** Shown once, never retrievable again. Held in state only, never stored. */
  const [issued, setIssued] = useState<{ id: string; secret: string; name: string } | null>(
    null
  );

  const load = useCallback(async () => {
    try {
      const [agentsJson, outboxJson] = await Promise.all([
        fetch("/api/outreach/agents").then((r) => r.json()),
        fetch("/api/outreach/outbox").then((r) => r.json()),
      ]);
      if (agentsJson.success) setAgents(agentsJson.data.agents);
      if (outboxJson.success) setEmails(outboxJson.data.emails);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  useEffect(() => {
    const interval = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(interval);
  }, [load]);

  async function decide(emailId: string, decision: "APPROVE" | "REJECT") {
    setBusyId(emailId);
    setError(null);
    try {
      const response = await fetch("/api/outreach/outbox", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ emailId, decision }),
      });
      const json = await response.json();
      if (!json.success) {
        setError(json.error ?? "That did not go through.");
      }
      await load();
    } finally {
      setBusyId(null);
    }
  }

  async function pairAgent() {
    setPairing(true);
    setError(null);
    try {
      const response = await fetch("/api/outreach/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newAgentName.trim() }),
      });
      const json = await response.json();
      if (!json.success) {
        setError(json.issues?.[0]?.message ?? json.error ?? "Could not pair that agent.");
        return;
      }
      setIssued({
        id: json.data.agent.id,
        secret: json.data.secret,
        name: json.data.agent.name,
      });
      setNewAgentName("");
      await load();
    } finally {
      setPairing(false);
    }
  }

  const waiting = emails.filter(
    (email) => email.status === "PENDING_REVIEW" && !email.pendingDecision
  );
  const decided = emails.filter(
    (email) => email.status === "PENDING_REVIEW" && email.pendingDecision
  );
  const sent = emails.filter((email) => email.status === "SENT");
  const offline = agents.filter((agent) => agent.status === "ACTIVE" && !agent.online);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-xl font-semibold">Outreach</h1>
        <p className="text-sm text-zinc-500">
          Cold email written on your machine, approved from here. Nothing sends
          until you say so.
        </p>
      </div>

      {error && (
        <div className="panel rounded border-l-2 border-l-red-500 p-4 text-sm">{error}</div>
      )}

      {offline.length > 0 && (
        <div className="panel rounded border-l-2 border-l-amber-500 p-4 text-sm">
          <strong>
            {offline.length === 1
              ? `Harvey "${offline[0].name}" hasn't checked in`
              : `${offline.length} agents haven't checked in`}
          </strong>
          <p className="mt-1 text-zinc-500">
            {offline.map((agent) => `${agent.name} (${sinceText(agent.lastSeenAt)})`).join(", ")}.
            Your decisions are saved and get applied as soon as it is back. They
            expire after three days, so personalization never goes out stale.
          </p>
        </div>
      )}

      <section className="panel rounded p-4 sm:p-6">
        <div className="mb-4 flex items-baseline justify-between gap-4">
          <h2 className="text-base font-semibold">Agents</h2>
          <span className="text-xs text-zinc-500">
            One per brand, each with its own secret
          </span>
        </div>
        {agents.length === 0 ? (
          <p className="text-sm text-zinc-500">
            No outbound agent paired yet. Pair one in Settings, then put its id
            and secret in that Harvey&apos;s <code>.env</code>.
          </p>
        ) : (
          <ul className="space-y-3">
            {agents.map((agent) => (
              <li
                key={agent.id}
                className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3 first:border-t-0 first:pt-0"
              >
                <div>
                  <div className="flex items-center gap-2 font-medium">
                    <span
                      aria-hidden
                      className={`inline-block h-2 w-2 rounded-full ${
                        agent.status === "REVOKED"
                          ? "bg-zinc-400"
                          : agent.online
                            ? "bg-emerald-500"
                            : "bg-amber-500"
                      }`}
                    />
                    {agent.name}
                    {agent.status === "REVOKED" && (
                      <span className="text-xs text-zinc-500">revoked</span>
                    )}
                  </div>
                  <div className="text-xs text-zinc-500">
                    {agent.status === "REVOKED"
                      ? "Secret no longer works"
                      : `Last seen ${sinceText(agent.lastSeenAt)}`}
                    {agent.whatsappPhone
                      ? ` · hands off to +${agent.whatsappPhone}`
                      : agent.defaultDestinationUrl
                        ? " · hands off to a booking page"
                        : " · no handoff set"}
                  </div>
                </div>
                <div className="text-right text-xs text-zinc-500">
                  <div>{agent._count.prospects} prospects</div>
                  <div>{agent._count.emails} emails</div>
                </div>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-5 border-t border-border pt-4">
          <label htmlFor="agent-name" className="text-sm font-medium">
            Pair another Harvey
          </label>
          <p className="mt-1 text-xs text-zinc-500">
            A short name you will recognise, like <code>feetbit-wholesale</code>.
            Pairing again with an existing name issues a fresh secret and
            retires the old one.
          </p>
          <div className="mt-2 flex flex-col gap-2 sm:flex-row">
            <input
              id="agent-name"
              value={newAgentName}
              onChange={(event) => setNewAgentName(event.target.value)}
              placeholder="feetbit-wholesale"
              className="w-full rounded border border-border bg-transparent px-3 py-2 text-sm"
            />
            <button
              type="button"
              disabled={pairing || newAgentName.trim().length < 2}
              onClick={() => void pairAgent()}
              className="w-full rounded border border-border px-4 py-2 text-sm disabled:opacity-50 sm:w-auto"
            >
              {pairing ? "Pairing…" : "Pair"}
            </button>
          </div>

          {issued && (
            <div className="mt-4 rounded border-l-2 border-l-emerald-500 bg-background p-3 text-sm">
              <div className="font-medium">
                Secret for &ldquo;{issued.name}&rdquo; — shown once
              </div>
              <p className="mt-1 text-xs text-zinc-500">
                Put these two lines in that Harvey&apos;s <code>.env</code>, then
                set <code>openreply.enabled: true</code> and{" "}
                <code>openreply.base_url</code> in its <code>harvey.yaml</code>.
                This secret is not retrievable — pair again to get a new one.
              </p>
              <pre className="mt-2 overflow-x-auto rounded bg-foreground/5 p-2 text-xs">
                {`OPENREPLY_AGENT_ID=${issued.id}\nOPENREPLY_AGENT_SECRET=${issued.secret}`}
              </pre>
              <button
                type="button"
                onClick={() => setIssued(null)}
                className="mt-2 text-xs text-zinc-500 hover:underline"
              >
                I have saved it — hide
              </button>
            </div>
          )}
        </div>
      </section>

      <section className="panel rounded p-4 sm:p-6">
        <div className="mb-1 flex items-baseline justify-between gap-4">
          <h2 className="text-base font-semibold">Approvals</h2>
          <span className="text-xs text-zinc-500">
            {waiting.length} waiting · {decided.length} with Harvey · {sent.length} sent
          </span>
        </div>

        {loading ? (
          <p className="mt-3 text-sm text-zinc-500">Loading…</p>
        ) : waiting.length === 0 ? (
          <p className="mt-3 text-sm text-zinc-500">
            Nothing waiting on you. Harvey queues an email here before it sends
            anything.
          </p>
        ) : (
          <ul className="mt-4 space-y-6">
            {waiting.map((email) => (
              <li key={email.id} className="border-t border-border pt-4 first:border-t-0 first:pt-0">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <span className="font-medium">{prospectName(email)}</span>
                  {email.prospect?.company?.name && (
                    <span className="text-sm text-zinc-500">
                      {email.prospect.company.name}
                    </span>
                  )}
                  <span className="text-xs text-zinc-500">
                    {email.kind === "reply" ? "reply" : `step ${email.step}`}
                  </span>
                  {email.prospect?.score !== null && email.prospect?.score !== undefined && (
                    <span className="text-xs text-zinc-500">score {email.prospect.score}</span>
                  )}
                  {email.prospect?.emailStatus &&
                    email.prospect.emailStatus !== "verified" && (
                      <span className="text-xs text-amber-600">
                        address {email.prospect.emailStatus}
                      </span>
                    )}
                  {email.trackedUrl && (
                    <span className="text-xs text-emerald-600">link tracked</span>
                  )}
                  {email.stale && (
                    <span className="text-xs text-amber-600">
                      written {sinceText(email.createdAt)} — worth a fresh look
                    </span>
                  )}
                </div>

                <div className="mt-1 text-xs text-zinc-500">{email.toEmail}</div>

                {email.prospect?.personalizationNotes && (
                  <p className="mt-2 text-xs text-zinc-500">
                    Why them: {email.prospect.personalizationNotes}
                  </p>
                )}

                <div className="mt-3 font-medium">{email.subject}</div>
                <p className="mt-1 whitespace-pre-wrap text-sm">{email.body}</p>

                <div className="mt-4 flex flex-col gap-2 sm:flex-row">
                  <button
                    type="button"
                    disabled={busyId === email.id}
                    onClick={() => void decide(email.id, "APPROVE")}
                    className="w-full rounded bg-foreground px-4 py-2 text-sm font-medium text-background disabled:opacity-50 sm:w-auto"
                  >
                    {busyId === email.id ? "Saving…" : "Approve"}
                  </button>
                  <button
                    type="button"
                    disabled={busyId === email.id}
                    onClick={() => void decide(email.id, "REJECT")}
                    className="w-full rounded border border-border px-4 py-2 text-sm disabled:opacity-50 sm:w-auto"
                  >
                    Don&apos;t send
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {(decided.length > 0 || sent.length > 0) && (
        <section className="panel rounded p-4 sm:p-6">
          <h2 className="mb-4 text-base font-semibold">Recently decided</h2>
          <ul className="space-y-3 text-sm">
            {[...decided, ...sent].slice(0, 20).map((email) => (
              <li
                key={email.id}
                className="flex flex-wrap items-baseline justify-between gap-2 border-t border-border pt-3 first:border-t-0 first:pt-0"
              >
                <div>
                  <div className="font-medium">{prospectName(email)}</div>
                  <div className="text-xs text-zinc-500">{email.subject}</div>
                </div>
                <div className="text-xs text-zinc-500">{statusLabel(email)}</div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
