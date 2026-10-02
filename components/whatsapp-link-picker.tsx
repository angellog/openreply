"use client";

/**
 * Lets a campaign send commenters to WhatsApp instead of a web link. Picks a
 * connected number and fills the link field with a wa.me URL whose ref is a
 * placeholder, resolved to the campaign's slug when the link is clicked.
 */

import { useEffect, useState } from "react";
import {
  buildWhatsAppHandoffTemplate,
  isWhatsAppHandoffUrl,
} from "@/lib/whatsapp/ref";

interface ConnectedNumber {
  id: string;
  name: string;
  phone: string;
}

export default function WhatsAppLinkPicker({
  currentUrl,
  onPick,
}: {
  currentUrl: string;
  onPick: (url: string) => void;
}) {
  const [numbers, setNumbers] = useState<ConnectedNumber[]>([]);
  const [message, setMessage] = useState("Hi! I saw your post");

  useEffect(() => {
    void (async () => {
      const res = await fetch("/api/whatsapp/sessions");
      const json = await res.json().catch(() => null);
      if (!json?.success) return;
      setNumbers(
        (json.data.sessions as { id: string; name: string; status: string; phone?: string | null }[])
          .filter((s) => s.status === "ready" && s.phone)
          .map((s) => ({ id: s.id, name: s.name, phone: s.phone! }))
      );
    })();
  }, []);

  if (numbers.length === 0) return null;

  return (
    <div className="rounded-lg border border-border p-3 space-y-2">
      <p className="text-xs text-zinc-500">
        {isWhatsAppHandoffUrl(currentUrl)
          ? "This link opens WhatsApp. Chats are credited to this campaign."
          : "Or send commenters to WhatsApp:"}
      </p>
      <input
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        placeholder="Pre-filled message"
        maxLength={120}
        className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-zinc-500 focus:border-accent/40 focus:outline-none"
      />
      <div className="flex flex-wrap gap-2">
        {numbers.map((n) => (
          <button
            key={n.id}
            type="button"
            onClick={() => onPick(buildWhatsAppHandoffTemplate({ phone: n.phone, message }))}
            className="rounded-lg border border-border px-3 py-1.5 text-xs hover:bg-surface"
          >
            WhatsApp {n.name} (+{n.phone})
          </button>
        ))}
      </div>
    </div>
  );
}
