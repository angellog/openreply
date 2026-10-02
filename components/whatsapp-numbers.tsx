"use client";

/**
 * WhatsApp numbers (Settings)
 *
 * Lists the numbers linked to the OpenWA gateway and adds new ones: create a
 * session, show its QR until the phone links it. The webhook to OpenReply is
 * registered server-side, so linking a number needs nothing else.
 */

import { useCallback, useEffect, useState } from "react";

interface WhatsAppSession {
  id: string;
  name: string;
  status: string;
  phone?: string | null;
  pushName?: string | null;
  lastError?: string | null;
}

const STATUS_LABEL: Record<string, string> = {
  created: "Created",
  initializing: "Starting",
  qr_ready: "Waiting for scan",
  authenticating: "Linking",
  ready: "Connected",
  disconnected: "Disconnected",
  failed: "Failed",
};

const STATUS_TONE: Record<string, string> = {
  ready: "text-emerald-400",
  disconnected: "text-amber-400",
  failed: "text-red-400",
};

export default function WhatsAppNumbers() {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [sessions, setSessions] = useState<WhatsAppSession[]>([]);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [linking, setLinking] = useState<WhatsAppSession | null>(null);
  const [qrCode, setQrCode] = useState<string | null>(null);
  const [linkStatus, setLinkStatus] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/whatsapp/sessions");
    const json = await res.json();
    if (json.success) {
      setConfigured(json.data.configured);
      setSessions(json.data.sessions);
    } else {
      setError(json.error ?? "Could not reach the WhatsApp gateway");
      setConfigured(true);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  // Poll the QR while the link dialog is open, until the phone links it.
  useEffect(() => {
    if (!linking) return;
    let cancelled = false;

    const tick = async () => {
      const res = await fetch(`/api/whatsapp/sessions/${linking.id}/qr`);
      const json = await res.json();
      if (cancelled || !json.success) return;
      setLinkStatus(json.data.status);
      setQrCode(json.data.qrCode);
      if (json.data.status === "ready") {
        setLinking(null);
        void load();
      }
    };

    void tick();
    const timer = setInterval(() => void tick(), 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [linking, load]);

  async function addNumber(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/whatsapp/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      });
      const json = await res.json();
      if (!json.success) {
        setError(json.error);
        return;
      }
      setName("");
      setQrCode(null);
      setLinkStatus(null);
      setLinking(json.data);
      void load();
    } finally {
      setBusy(false);
    }
  }

  async function reconnect(session: WhatsAppSession) {
    setError(null);
    const res = await fetch(`/api/whatsapp/sessions/${session.id}/start`, {
      method: "POST",
    });
    const json = await res.json();
    if (!json.success) {
      setError(json.error);
      return;
    }
    setQrCode(null);
    setLinkStatus(null);
    setLinking(session);
  }

  async function remove(session: WhatsAppSession) {
    if (!confirm(`Remove ${session.name}? Its chats stop arriving in OpenReply.`)) {
      return;
    }
    const res = await fetch(`/api/whatsapp/sessions/${session.id}`, {
      method: "DELETE",
    });
    const json = await res.json();
    if (!json.success) setError(json.error);
    void load();
  }

  return (
    <section className="panel rounded p-4 sm:p-6">
      <h2 className="text-base font-semibold mb-2">WhatsApp Numbers</h2>
      <p className="mb-6 text-sm text-zinc-500">
        Link a <strong>spare</strong> number, never your main business line. The
        gateway runs an unofficial WhatsApp client, and a banned number can&apos;t
        be recovered.
      </p>

      {configured === false ? (
        <p className="text-sm text-zinc-500">
          The WhatsApp gateway isn&apos;t configured. Set OPENWA_BASE_URL and
          OPENWA_API_KEY to enable it.
        </p>
      ) : (
        <>
          {sessions.length > 0 && (
            <ul className="mb-6 divide-y divide-border rounded-lg border border-border">
              {sessions.map((session) => (
                <li
                  key={session.id}
                  className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                >
                  <div>
                    <div className="text-sm font-medium">
                      {session.name}
                      {session.phone && (
                        <span className="ml-2 text-zinc-500">+{session.phone}</span>
                      )}
                    </div>
                    <div
                      className={`text-xs ${STATUS_TONE[session.status] ?? "text-zinc-500"}`}
                    >
                      {STATUS_LABEL[session.status] ?? session.status}
                      {session.lastError && ` · ${session.lastError}`}
                    </div>
                  </div>
                  <div className="flex gap-2">
                    {session.status !== "ready" && (
                      <button
                        onClick={() => void reconnect(session)}
                        className="rounded-lg border border-border px-3 py-1.5 text-xs hover:bg-surface"
                      >
                        Show QR
                      </button>
                    )}
                    <button
                      onClick={() => void remove(session)}
                      className="rounded-lg border border-border px-3 py-1.5 text-xs text-red-400 hover:bg-surface"
                    >
                      Remove
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          <form onSubmit={addNumber} className="flex flex-wrap gap-2">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Name, e.g. feetbit"
              className="flex-1 min-w-48 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-zinc-500 focus:border-accent/40 focus:outline-none"
            />
            <button
              type="submit"
              disabled={busy || name.trim().length < 3}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
            >
              {busy ? "Adding…" : "Add number"}
            </button>
          </form>
        </>
      )}

      {error && <p className="mt-3 text-sm text-red-400">{error}</p>}

      {linking && (
        <div className="mt-6 rounded-lg border border-border p-4 text-center">
          <p className="mb-1 text-sm font-medium">Link {linking.name}</p>
          <p className="mb-4 text-xs text-zinc-500">
            On the phone: WhatsApp → Settings → Linked devices → Link a device
          </p>
          {qrCode ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={qrCode}
              alt="WhatsApp QR code"
              className="mx-auto h-56 w-56 rounded bg-white p-2"
            />
          ) : (
            <p className="py-10 text-sm text-zinc-500">
              {linkStatus === "authenticating"
                ? "Linking…"
                : linkStatus === "failed"
                  ? "Couldn't start. Try Show QR again."
                  : "Preparing QR code…"}
            </p>
          )}
          <button
            onClick={() => setLinking(null)}
            className="mt-4 text-xs text-zinc-500 underline"
          >
            Close
          </button>
        </div>
      )}
    </section>
  );
}
