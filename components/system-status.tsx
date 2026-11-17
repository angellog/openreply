"use client";

/**
 * One fetch of /api/systems/status, shared by everything that needs it.
 *
 * The sidebar dots, the top bar's banner, the systems map and the guide all ask
 * the same question. Without a shared provider each of them would poll, and a
 * phone on a slow connection would spend its battery asking four times what it
 * could ask once.
 *
 * Nav structure comes from the registry directly — it is static data and does
 * not need a round trip. Only the live states come from here.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { readCache, writeCache } from "@/lib/client-cache";
import type { SystemId } from "@/lib/systems/registry";
import type { SystemState, SystemStatus } from "@/lib/systems/status";

const CACHE_KEY = "systems-status-v1";
/** Shown immediately from cache, then revalidated. */
const CACHE_MAX_AGE_MS = 60 * 1000;
const POLL_MS = 60 * 1000;

interface StatusPayload {
  statuses: SystemStatus[];
  worst: SystemState;
}

interface SystemStatusContextValue {
  byId: Partial<Record<SystemId, SystemStatus>>;
  statuses: SystemStatus[];
  worst: SystemState | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

const SystemStatusContext = createContext<SystemStatusContextValue>({
  byId: {},
  statuses: [],
  worst: null,
  loading: true,
  error: null,
  refresh: () => {},
});

export function SystemStatusProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [payload, setPayload] = useState<StatusPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Guards against a slow response landing after the component is gone, and
  // against two overlapping fetches when a poll and a manual refresh collide.
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const hydratedFromCache = useRef(false);

  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      // The cached states go up first so navigating between pages does not
      // blank every dot while one request is in flight.
      //
      // Read here rather than in the initial useState: the server has no
      // sessionStorage, so seeding state from it during render makes the first
      // client render disagree with the HTML the server sent, and React throws
      // the whole subtree away and rebuilds it. That is a real hydration error,
      // not a warning. One tick later, from a timer callback, is correct and
      // imperceptible.
      if (!hydratedFromCache.current) {
        hydratedFromCache.current = true;
        const cached = readCache<StatusPayload>(CACHE_KEY, CACHE_MAX_AGE_MS);
        if (cached.data) {
          setPayload(cached.data);
          setLoading(false);
        }
      }

      const response = await fetch("/api/systems/status");
      const json = await response.json();
      if (!mounted.current) return;
      if (!json.success) {
        setError(json.error ?? "Could not read system status");
        return;
      }
      const next: StatusPayload = {
        statuses: json.data.statuses,
        worst: json.data.worst,
      };
      setPayload(next);
      writeCache(CACHE_KEY, next);
      setError(null);
    } catch {
      if (mounted.current) setError("Could not reach the server");
    } finally {
      inFlight.current = false;
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    const tick = () => void load();
    // Queued rather than called in the effect body. The first fetch is the same
    // kind of event as every later poll, so it goes through the same path, and
    // the effect body is left doing nothing but registering things. Cached dots
    // are already on screen, so the extra tick is invisible.
    const first = setTimeout(tick, 0);
    const timer = setInterval(tick, POLL_MS);
    // Coming back to a backgrounded tab, the cached dots are the stalest thing
    // on screen, so refresh before the next tick rather than after it.
    window.addEventListener("focus", tick);
    return () => {
      mounted.current = false;
      clearTimeout(first);
      clearInterval(timer);
      window.removeEventListener("focus", tick);
    };
  }, [load]);

  const value = useMemo<SystemStatusContextValue>(() => {
    const byId: Partial<Record<SystemId, SystemStatus>> = {};
    for (const status of payload?.statuses ?? []) byId[status.id] = status;
    return {
      byId,
      statuses: payload?.statuses ?? [],
      worst: payload?.worst ?? null,
      loading,
      error,
      refresh: () => void load(),
    };
  }, [payload, loading, error, load]);

  return (
    <SystemStatusContext.Provider value={value}>
      {children}
    </SystemStatusContext.Provider>
  );
}

export function useSystemStatus() {
  return useContext(SystemStatusContext);
}

/** What each state is called on screen, and the colour it earns. */
export const STATE_META: Record<
  SystemState,
  { label: string; dot: string; text: string; chip: string }
> = {
  live: {
    label: "Running",
    dot: "bg-success",
    text: "text-success",
    chip: "bg-success/10 text-success border-success/30",
  },
  idle: {
    label: "Idle",
    dot: "bg-muted",
    text: "text-muted",
    chip: "bg-surface text-muted border-border",
  },
  attention: {
    label: "Needs you",
    dot: "bg-warning",
    text: "text-warning",
    chip: "bg-warning/10 text-warning border-warning/30",
  },
  setup: {
    label: "Not set up",
    dot: "bg-border-hover",
    text: "text-muted",
    chip: "bg-surface text-muted border-border",
  },
  unknown: {
    label: "Unknown",
    dot: "bg-error",
    text: "text-error",
    chip: "bg-error/10 text-error border-error/30",
  },
};

/**
 * The dot. Carries its meaning in text too, because a colour alone is not a
 * status for anyone who cannot distinguish amber from green.
 */
export function StatusDot({
  state,
  className = "",
}: {
  state: SystemState | null;
  className?: string;
}) {
  if (!state) {
    return (
      <span
        className={`inline-block h-2 w-2 shrink-0 rounded-full bg-border ${className}`}
        aria-hidden
      />
    );
  }
  const meta = STATE_META[state];
  return (
    <span
      className={`inline-block h-2 w-2 shrink-0 rounded-full ${meta.dot} ${className}`}
      role="img"
      aria-label={meta.label}
      title={meta.label}
    />
  );
}

export function StatusChip({ state }: { state: SystemState }) {
  const meta = STATE_META[state];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded border px-2 py-0.5 text-xs font-medium ${meta.chip}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} aria-hidden />
      {meta.label}
    </span>
  );
}
