"use client";

/**
 * WhatsApp Leads Page
 *
 * Chats that started from an Instagram campaign, attributed through the
 * tracked-link ref the customer sent in their first message.
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
  lastOutboundAt: string | null;
  createdAt: string;
  automation: { name: string } | null;
  instagramAccount: { username: string } | null;
  messages: { body: string; direction: string; createdAt: string }[];
  _count: { messages: number };
}

interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

function formatWhen(value: string | null) {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}

export default function WhatsAppLeadsPage() {
  const [leads, setLeads] = useState<WhatsAppLead[]>([]);
  const [pagination, setPagination] = useState<Pagination | null>(null);
  const [loading, setLoading] = useState(true);
  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState("all");
  const [page, setPage] = useState(1);

  const fetchLeads = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), limit: "20" });
      if (selectedAccountId !== "all") {
        params.set("instagramAccountId", selectedAccountId);
      }
      const response = await fetch(`/api/whatsapp/leads?${params.toString()}`);
      const json = await response.json();
      if (json.success) {
        setLeads(json.data.leads);
        setPagination(json.data.pagination);
      }
    } finally {
      setLoading(false);
    }
  }, [page, selectedAccountId]);

  useEffect(() => {
    void fetchLeads();
  }, [fetchLeads]);

  useEffect(() => {
    void (async () => {
      const response = await fetch("/api/instagram/accounts");
      const json = await response.json();
      if (json.success) setAccounts(json.data ?? []);
    })();
  }, []);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">WhatsApp leads</h1>
          <p className="text-sm text-gray-500">
            Chats that began from a campaign link. The ref in the first message
            is what ties a chat back to its post.
          </p>
        </div>
        <AccountSelect
          accounts={accounts}
          value={selectedAccountId}
          onChange={(value) => {
            setSelectedAccountId(value);
            setPage(1);
          }}
        />
      </div>

      {loading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : leads.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center">
          <p className="font-medium">No WhatsApp leads yet</p>
          <p className="mt-1 text-sm text-gray-500">
            Point a campaign&apos;s link at your WhatsApp number. When someone
            taps it and sends the pre-filled message, they appear here.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 text-left">
              <tr>
                <th className="px-4 py-3 font-medium">Contact</th>
                <th className="px-4 py-3 font-medium">Campaign</th>
                <th className="px-4 py-3 font-medium">Account</th>
                <th className="px-4 py-3 font-medium">Last message</th>
                <th className="px-4 py-3 font-medium">Msgs</th>
                <th className="px-4 py-3 font-medium">Last inbound</th>
              </tr>
            </thead>
            <tbody>
              {leads.map((lead) => (
                <tr key={lead.id} className="border-t align-top">
                  <td className="px-4 py-3">
                    <div className="font-medium">
                      {lead.displayName ?? lead.phone ?? lead.chatId}
                    </div>
                    {lead.phone && (
                      <div className="text-xs text-gray-500">+{lead.phone}</div>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {lead.automation?.name ?? (
                      <span className="text-gray-400">Unattributed</span>
                    )}
                    {lead.refSlug && (
                      <div className="text-xs text-gray-500">
                        ref {lead.refSlug}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {lead.instagramAccount?.username
                      ? `@${lead.instagramAccount.username}`
                      : "—"}
                  </td>
                  <td className="max-w-xs px-4 py-3">
                    {lead.messages[0] ? (
                      <>
                        <span className="text-xs uppercase text-gray-400">
                          {lead.messages[0].direction === "INBOUND" ? "in" : "out"}
                        </span>{" "}
                        <span className="line-clamp-2">
                          {lead.messages[0].body}
                        </span>
                      </>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-4 py-3">{lead._count.messages}</td>
                  <td className="px-4 py-3">{formatWhen(lead.lastInboundAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pagination && pagination.totalPages > 1 && (
        <div className="flex items-center justify-between text-sm">
          <span className="text-gray-500">
            Page {pagination.page} of {pagination.totalPages} · {pagination.total}{" "}
            leads
          </span>
          <div className="flex gap-2">
            <button
              className="rounded border px-3 py-1 disabled:opacity-40"
              disabled={pagination.page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              Previous
            </button>
            <button
              className="rounded border px-3 py-1 disabled:opacity-40"
              disabled={pagination.page >= pagination.totalPages}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
