"use client";

/**
 * WhatsApp Page
 *
 * Top: per-campaign path from Instagram to WhatsApp (DMs → clicks → chats).
 * Below: every chat that began from a campaign link, attributed through the
 * ref the customer sent in their first message.
 */

import { useCallback, useEffect, useState } from "react";
import AccountSelect, { type AccountOption } from "@/components/account-select";

interface WhatsAppLead {
  id: string;
  chatId: string;
  phone: string | null;
  displayName: string | null;
  refSlug: string | null;
  lastInboundAt: string | null;
  automation: { name: string } | null;
  instagramAccount: { username: string } | null;
  messages: { body: string; direction: string; createdAt: string }[];
  _count: { messages: number };
}

interface FunnelRow {
  automationId: string;
  name: string;
  account: string | null;
  dmsSent: number;
  clicks: number;
  whatsappLeads: number;
}

interface Pagination {
  page: number;
  totalPages: number;
  total: number;
}

function rate(part: number, whole: number) {
  if (whole === 0) return "—";
  return `${Math.round((part / whole) * 100)}%`;
}

function formatWhen(value: string | null) {
  return value ? new Date(value).toLocaleString() : "—";
}

export default function WhatsAppPage() {
  const [funnel, setFunnel] = useState<FunnelRow[]>([]);
  const [leads, setLeads] = useState<WhatsAppLead[]>([]);
  const [pagination, setPagination] = useState<Pagination | null>(null);
  const [loading, setLoading] = useState(true);
  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState("all");
  const [page, setPage] = useState(1);

  const fetchLeads = useCallback(async () => {
    try {
      const params = new URLSearchParams({ page: String(page), limit: "20" });
      if (selectedAccountId !== "all") params.set("instagramAccountId", selectedAccountId);
      const json = await (await fetch(`/api/whatsapp/leads?${params}`)).json();
      if (json.success) {
        setLeads(json.data.leads);
        setPagination(json.data.pagination);
      }
    } finally {
      setLoading(false);
    }
  }, [page, selectedAccountId]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void fetchLeads();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [fetchLeads]);

  useEffect(() => {
    void (async () => {
      const [funnelJson, statsJson] = await Promise.all([
        fetch("/api/whatsapp/funnel").then((r) => r.json()),
        fetch("/api/dashboard/stats").then((r) => r.json()),
      ]);
      if (funnelJson.success) setFunnel(funnelJson.data.funnel);
      if (statsJson.success) setAccounts(statsJson.data.instagramAccounts ?? []);
    })();
  }, []);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-xl font-semibold">WhatsApp</h1>
        <p className="text-sm text-zinc-500">
          From an Instagram comment to a WhatsApp chat, per campaign.
        </p>
      </div>

      <section className="panel rounded p-4 sm:p-6">
        <h2 className="text-base font-semibold mb-4">Instagram → WhatsApp</h2>
        {funnel.length === 0 ? (
          <p className="text-sm text-zinc-500">No campaign activity yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="text-left text-zinc-500">
                <tr>
                  <th className="py-2 pr-4 font-medium">Campaign</th>
                  <th className="py-2 pr-4 font-medium">DMs sent</th>
                  <th className="py-2 pr-4 font-medium">Link clicks</th>
                  <th className="py-2 pr-4 font-medium">WhatsApp chats</th>
                  <th className="py-2 font-medium">DM → chat</th>
                </tr>
              </thead>
              <tbody>
                {funnel.map((row) => (
                  <tr key={row.automationId} className="border-t border-border">
                    <td className="py-2 pr-4">
                      <div className="font-medium">{row.name}</div>
                      {row.account && (
                        <div className="text-xs text-zinc-500">@{row.account}</div>
                      )}
                    </td>
                    <td className="py-2 pr-4">{row.dmsSent}</td>
                    <td className="py-2 pr-4">
                      {row.clicks}{" "}
                      <span className="text-xs text-zinc-500">{rate(row.clicks, row.dmsSent)}</span>
                    </td>
                    <td className="py-2 pr-4">{row.whatsappLeads}</td>
                    <td className="py-2">{rate(row.whatsappLeads, row.dmsSent)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel rounded p-4 sm:p-6">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-4">
          <h2 className="text-base font-semibold">Chats</h2>
          <AccountSelect
            accounts={accounts}
            value={selectedAccountId}
            onChange={(value) => {
              setLoading(true);
              setSelectedAccountId(value);
              setPage(1);
            }}
          />
        </div>

        {loading ? (
          <p className="text-sm text-zinc-500">Loading…</p>
        ) : leads.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-8 text-center">
            <p className="font-medium">No WhatsApp chats yet</p>
            <p className="mt-1 text-sm text-zinc-500">
              Connect a number in Settings, then pick it as a campaign&apos;s link.
              Chats appear here once someone taps it and sends the pre-filled message.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="text-left text-zinc-500">
                <tr>
                  <th className="py-2 pr-4 font-medium">Contact</th>
                  <th className="py-2 pr-4 font-medium">Campaign</th>
                  <th className="py-2 pr-4 font-medium">Last message</th>
                  <th className="py-2 pr-4 font-medium">Msgs</th>
                  <th className="py-2 font-medium">Last inbound</th>
                </tr>
              </thead>
              <tbody>
                {leads.map((lead) => (
                  <tr key={lead.id} className="border-t border-border align-top">
                    <td className="py-2 pr-4">
                      <div className="font-medium">
                        {lead.displayName ?? (lead.phone ? `+${lead.phone}` : lead.chatId)}
                      </div>
                      {lead.displayName && lead.phone && (
                        <div className="text-xs text-zinc-500">+{lead.phone}</div>
                      )}
                    </td>
                    <td className="py-2 pr-4">
                      {lead.automation?.name ?? <span className="text-zinc-500">Unattributed</span>}
                      {lead.instagramAccount && (
                        <div className="text-xs text-zinc-500">@{lead.instagramAccount.username}</div>
                      )}
                    </td>
                    <td className="max-w-xs py-2 pr-4">
                      {lead.messages[0] ? (
                        <span className="line-clamp-2">
                          <span className="text-xs uppercase text-zinc-500">
                            {lead.messages[0].direction === "INBOUND" ? "in " : "out "}
                          </span>
                          {lead.messages[0].body}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="py-2 pr-4">{lead._count.messages}</td>
                    <td className="py-2">{formatWhen(lead.lastInboundAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {pagination && pagination.totalPages > 1 && (
          <div className="mt-4 flex items-center justify-between text-sm">
            <span className="text-zinc-500">
              Page {pagination.page} of {pagination.totalPages} · {pagination.total} chats
            </span>
            <div className="flex gap-2">
              <button
                className="rounded-lg border border-border px-3 py-1 disabled:opacity-40"
                disabled={pagination.page <= 1}
                onClick={() => {
                  setLoading(true);
                  setPage((p) => Math.max(1, p - 1));
                }}
              >
                Previous
              </button>
              <button
                className="rounded-lg border border-border px-3 py-1 disabled:opacity-40"
                disabled={pagination.page >= pagination.totalPages}
                onClick={() => {
                  setLoading(true);
                  setPage((p) => p + 1);
                }}
              >
                Next
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
