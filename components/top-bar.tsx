"use client";

/**
 * Top Bar
 *
 * Page title, which system the page belongs to, the mobile hamburger, and the
 * Instagram connection state.
 *
 * The title used to come from a hand-kept map of paths, which meant every new
 * page silently showed "Dashboard" until somebody remembered. It now comes
 * from the systems registry, so a page that exists in the nav has a title by
 * construction.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { listSystems, systemForPath } from "@/lib/systems/registry";
import { StatusDot, useSystemStatus } from "@/components/system-status";

/** The longest registry page href that prefixes this path wins, so
 *  /outreach/resources beats /outreach. */
function titleForPath(pathname: string): string {
  let best: { label: string; length: number } | null = null;
  for (const system of listSystems()) {
    for (const page of system.pages) {
      const matches =
        pathname === page.href || pathname.startsWith(page.href + "/");
      if (matches && (!best || page.href.length > best.length)) {
        best = { label: page.label, length: page.href.length };
      }
    }
  }
  return best?.label ?? "Dashboard";
}

interface TopBarProps {
  onMenuClick: () => void;
  instagramUsername: string | null;
  instagramAccountCount: number;
}

export default function TopBar({
  onMenuClick,
  instagramUsername,
  instagramAccountCount,
}: TopBarProps) {
  const pathname = usePathname();
  const { byId } = useSystemStatus();
  const title = titleForPath(pathname);
  const system = systemForPath(pathname);
  const status = system ? byId[system.id] : undefined;

  return (
    <header
      className="sticky top-0 z-30 flex items-center justify-between gap-3 px-4 lg:px-8 border-b border-border bg-background"
      // Installed to the home screen the app starts at the very top of the
      // display, so without this the title sits under the clock and battery.
      // The inset is 0 in a browser tab and on desktop.
      style={{
        height: "calc(4rem + env(safe-area-inset-top))",
        paddingTop: "env(safe-area-inset-top)",
      }}
    >
      <div className="flex min-w-0 items-center gap-3 sm:gap-4">
        <button
          onClick={onMenuClick}
          className="lg:hidden shrink-0 px-2.5 py-1.5 rounded border border-border text-sm text-muted hover:text-foreground"
          aria-label="Toggle sidebar"
        >
          Menu
        </button>
        <div className="min-w-0">
          <h1 className="truncate text-base font-semibold sm:text-lg">
            {title}
          </h1>
          {system && (
            <Link
              href={`/systems#${system.id}`}
              // Named explicitly: the only text inside is the system name next
              // to an icon, and the computed name came out empty.
              aria-label={`${system.name} — open the systems map`}
              className="flex items-center gap-1.5 text-xs text-muted hover:text-foreground"
            >
              <StatusDot state={status?.state ?? null} />
              <span className="truncate">{system.name}</span>
            </Link>
          )}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2 sm:gap-3">
        {/* The guide is the answer to "what am I looking at", so it belongs
            one tap away on every page rather than buried in the nav. */}
        <Link
          href={system ? `/guide#${system.id}` : "/guide"}
          className="rounded border border-border px-2.5 py-1.5 text-sm text-muted hover:text-foreground"
          aria-label="Open the guide for this page"
          title="How this page works"
        >
          ?
        </Link>

        {instagramAccountCount > 0 ? (
          <p className="truncate text-sm text-muted">
            {instagramAccountCount > 1
              ? `${instagramAccountCount} accounts`
              : `@${instagramUsername}`}
          </p>
        ) : (
          <a
            href="/api/instagram/connect"
            className="whitespace-nowrap rounded bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-hover"
          >
            {/* Full label needs more room than a 360px header has to spare. */}
            <span className="sm:hidden">Connect</span>
            <span className="hidden sm:inline">Connect Instagram</span>
          </a>
        )}
      </div>
    </header>
  );
}
