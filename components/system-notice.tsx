"use client";

/**
 * The banner a page shows when its own system is not ready.
 *
 * An operator who opens the approvals desk and finds it empty has no way to
 * tell the difference between "Harvey has nothing for you" and "Harvey has
 * never checked in because the keys are not in its .env". Both look like an
 * empty list. This says which, on the page where the question comes up.
 *
 * Rendered once in the shell rather than pasted into every page: it reads the
 * current path, finds that path's system in the registry, and stays out of the
 * way unless that system is in setup or needs attention. Pages that are fine
 * render nothing and shift nothing.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { systemForPath } from "@/lib/systems/registry";
import { STATE_META, useSystemStatus } from "@/components/system-status";

export default function SystemNotice() {
  const pathname = usePathname();
  const { byId } = useSystemStatus();
  const system = systemForPath(pathname);
  const status = system ? byId[system.id] : undefined;

  if (!system || !status) return null;

  // The map and the guide already explain every state in full; repeating a
  // banner there would be talking over them.
  if (pathname === "/systems" || pathname === "/guide") return null;

  // "Running" and "Idle" are not problems, and "Unknown" means the probe
  // failed, which is a diagnostics matter rather than something to interrupt
  // the page with.
  if (status.state !== "setup" && status.state !== "attention") return null;

  const meta = STATE_META[status.state];
  // The next step often points at the page that owns the system, which is
  // frequently the page you are already reading. A button that reloads where
  // you already are reads as broken, so the summary carries it alone — the
  // controls it would send you to are below the banner anyway.
  const action =
    status.nextStep?.href && status.nextStep.href !== pathname
      ? status.nextStep
      : null;

  return (
    <div
      className={`mb-5 rounded border p-3 sm:p-4 ${meta.chip}`}
      role="status"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className={`h-2 w-2 rounded-full ${meta.dot}`} aria-hidden />
        <p className="text-sm font-semibold">
          {system.name}: {meta.label.toLowerCase()}
        </p>
      </div>
      <p className="mt-1.5 text-sm text-foreground">{status.summary}</p>
      <div className="mt-2.5 flex flex-wrap items-center gap-3">
        {action?.href && (
          <Link
            href={action.href}
            className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-hover"
          >
            {action.label}
          </Link>
        )}
        <Link
          href={`/guide#${system.id}`}
          className="text-sm font-medium text-foreground underline"
        >
          How {system.name} works
        </Link>
      </div>
    </div>
  );
}
