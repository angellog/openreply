"use client";

/**
 * Sidebar navigation, grouped by system.
 *
 * It used to be ten links in one list, which was honest about the file layout
 * and silent about everything an operator needs: which machine a page talks
 * to, whether that machine is awake, and what has to be true before the page
 * does anything. Each group is now a system from the registry, with a live
 * state dot next to its name, so "nothing is happening" and "nothing is
 * running" stop looking the same.
 *
 * The groups come from lib/systems/registry, which is plain data, so the nav
 * renders before any request finishes. Only the dots wait on the network.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { listSystems } from "@/lib/systems/registry";
import { StatusDot, useSystemStatus } from "@/components/system-status";

interface SidebarProps {
  isOpen: boolean;
  onClose: () => void;
  workspaceName: string;
}

export default function Sidebar({
  isOpen,
  onClose,
  workspaceName,
}: SidebarProps) {
  const pathname = usePathname();
  const { byId } = useSystemStatus();
  const systems = listSystems();

  return (
    <>
      {isOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/60 lg:hidden"
          onClick={onClose}
        />
      )}

      <aside
        className={`
          fixed top-0 left-0 z-50 h-dvh w-64 max-w-[85vw] shrink-0 bg-surface border-r border-border flex flex-col
          transition-transform duration-200 ease-out
          lg:h-full lg:translate-x-0 lg:static lg:z-auto
          ${isOpen ? "translate-x-0" : "-translate-x-full"}
        `}
      >
        {/* Same reason as the top bar: the drawer is full height, so the
            wordmark would otherwise land under the status bar. */}
        <div
          className="px-6 py-5 border-b border-border"
          style={{ paddingTop: "calc(1.25rem + env(safe-area-inset-top))" }}
        >
          <Link href="/dashboard" className="text-base font-semibold">
            OpenReply
          </Link>
        </div>

        <nav
          className="flex-1 overflow-y-auto px-3 py-4"
          aria-label="Systems and pages"
        >
          {systems.map((system) => {
            const status = byId[system.id];
            const pages = system.pages.filter((page) => !page.hiddenInNav);

            return (
              <div key={system.id} className="mb-5 last:mb-0">
                <Link
                  href={`/systems#${system.id}`}
                  onClick={onClose}
                  className="group flex items-center gap-2 px-3 pb-1.5"
                  // The system's name leads, then the summary. Chrome names a
                  // link from its title when one is set, so a title holding
                  // only the summary would have a screen reader announce
                  // "12 DMs sent in the last 7 days" with no clue which system
                  // that is — and the announced name would no longer contain
                  // the visible label, which is WCAG 2.5.3.
                  title={
                    status ? `${system.name} — ${status.summary}` : system.name
                  }
                >
                  <StatusDot state={status?.state ?? null} />
                  <span className="text-xs font-semibold uppercase tracking-wide text-muted group-hover:text-foreground">
                    {system.name}
                  </span>
                  {status?.state === "attention" && (
                    <span className="ml-auto text-xs font-medium text-warning">
                      !
                    </span>
                  )}
                </Link>

                <div className="space-y-0.5">
                  {pages.map((page) => {
                    const isActive =
                      pathname === page.href ||
                      pathname.startsWith(page.href + "/");
                    return (
                      <Link
                        key={page.href}
                        href={page.href}
                        onClick={onClose}
                        aria-current={isActive ? "page" : undefined}
                        className={`
                          block rounded px-3 py-2 text-sm
                          ${
                            isActive
                              ? "bg-surface-hover font-medium text-foreground"
                              : "text-muted hover:bg-surface-hover hover:text-foreground"
                          }
                        `}
                      >
                        {page.label}
                      </Link>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </nav>

        <div className="border-t border-border px-5 py-4">
          <p className="truncate text-sm text-foreground">{workspaceName}</p>
          <p className="text-xs text-muted">Self-hosted</p>
        </div>
      </aside>
    </>
  );
}
