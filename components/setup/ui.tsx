"use client";

/**
 * Shared primitives for the Setup Console.
 *
 * Deliberately plain, matching the app's design system: flat surfaces, one
 * accent colour, no gradients or animation. The console is a diagnostic tool
 * and should read like one.
 */

import { useCallback, useState } from "react";
import type { CheckStatus } from "@/components/setup/types";

const STATUS_COLOR: Record<CheckStatus, string> = {
  ok: "bg-success",
  warn: "bg-warning",
  error: "bg-error",
  skipped: "bg-muted",
};

const STATUS_TEXT: Record<CheckStatus, string> = {
  ok: "text-success",
  warn: "text-warning",
  error: "text-error",
  skipped: "text-muted",
};

export function StatusDot({
  status,
  className = "",
}: {
  status: CheckStatus;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={`inline-block h-2 w-2 shrink-0 rounded-full ${STATUS_COLOR[status]} ${className}`}
    />
  );
}

export function statusTextClass(status: CheckStatus): string {
  return STATUS_TEXT[status];
}

export function Panel({
  title,
  description,
  children,
  actions,
}: {
  title?: string;
  description?: string;
  children: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <section className="panel rounded p-6">
      {(title || actions) && (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            {title && (
              <h2 className="text-base font-semibold text-foreground">{title}</h2>
            )}
            {description && (
              <p className="mt-1 max-w-2xl text-sm text-muted">{description}</p>
            )}
          </div>
          {actions && <div className="flex shrink-0 gap-2">{actions}</div>}
        </div>
      )}
      <div className={title || actions ? "mt-5" : ""}>{children}</div>
    </section>
  );
}

type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";

const BUTTON_STYLES: Record<ButtonVariant, string> = {
  primary:
    "bg-accent text-background hover:bg-accent-hover border border-transparent",
  secondary:
    "border border-border bg-surface text-foreground hover:border-border-hover",
  danger: "border border-error/40 bg-transparent text-error hover:bg-error/10",
  ghost: "border border-transparent text-muted hover:text-foreground",
};

export function Button({
  variant = "secondary",
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return (
    <button
      {...props}
      className={`rounded px-3 py-2 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${BUTTON_STYLES[variant]} ${className}`}
    />
  );
}

/**
 * A read-only value with a copy button.
 *
 * Every string the Meta console asks for has to match this instance exactly, so
 * these are shown to be copied, never retyped.
 */
export function CopyField({
  label,
  value,
  note,
  mono = true,
}: {
  label: string;
  value: string;
  note?: string;
  mono?: boolean;
}) {
  const { copied, copy } = useCopy();

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted">
          {label}
        </span>
        <button
          type="button"
          onClick={() => copy(value)}
          className="text-xs font-semibold text-accent hover:text-accent-hover"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <div
        className={`mt-1.5 overflow-x-auto rounded border border-border bg-background px-3 py-2 text-sm text-foreground ${
          mono ? "font-mono" : ""
        }`}
      >
        <span className="whitespace-nowrap">{value}</span>
      </div>
      {note && <p className="mt-1.5 text-xs text-muted">{note}</p>}
    </div>
  );
}

export function CodeLine({ children }: { children: string }) {
  const { copied, copy } = useCopy();

  return (
    <div className="flex items-center gap-2 rounded border border-border bg-background px-3 py-2">
      <code className="flex-1 overflow-x-auto whitespace-nowrap font-mono text-xs text-foreground">
        {children}
      </code>
      <button
        type="button"
        onClick={() => copy(children)}
        className="shrink-0 text-xs font-semibold text-accent hover:text-accent-hover"
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

export function useCopy() {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Clipboard access can be denied; the value is on screen either way.
      return;
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }, []);

  return { copied, copy };
}

export function Field({
  label,
  hint,
  error,
  children,
  htmlFor,
}: {
  label: string;
  hint?: string | null;
  error?: string | null;
  children: React.ReactNode;
  htmlFor?: string;
}) {
  return (
    <div>
      <label
        htmlFor={htmlFor}
        className="block text-sm font-semibold text-foreground"
      >
        {label}
      </label>
      {children}
      {error ? (
        <p className="mt-1.5 text-xs text-error">{error}</p>
      ) : hint ? (
        <p className="mt-1.5 text-xs text-muted">{hint}</p>
      ) : null}
    </div>
  );
}

export const inputClass =
  "mt-1.5 w-full rounded border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted/60 focus:border-accent";

export function Callout({
  tone = "info",
  title,
  children,
}: {
  tone?: "info" | "warn" | "error" | "success";
  title?: string;
  children: React.ReactNode;
}) {
  const tones = {
    info: "border-accent/40 bg-accent/5",
    warn: "border-warning/40 bg-warning/5",
    error: "border-error/40 bg-error/5",
    success: "border-success/40 bg-success/5",
  } as const;

  return (
    <div className={`rounded border px-4 py-3 text-sm ${tones[tone]}`}>
      {title && <p className="font-semibold text-foreground">{title}</p>}
      <div className={`text-muted ${title ? "mt-1" : ""}`}>{children}</div>
    </div>
  );
}

export function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded border border-dashed border-border py-8 text-center text-sm text-muted">
      {children}
    </p>
  );
}
