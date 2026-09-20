"use client";

/**
 * The `.env` editor.
 *
 * Secrets arrive masked and stay masked until you ask to see one — the form
 * tracks which fields you actually edited and only sends those, so saving after
 * touching one field cannot overwrite the others with their own masks.
 */

import { useMemo, useState } from "react";
import {
  Button,
  Callout,
  CodeLine,
  Field,
  Panel,
  inputClass,
} from "@/components/setup/ui";
import type { SetupField, SetupState } from "@/components/setup/types";

interface SaveResult {
  ok: boolean;
  message: string;
  restartRequired?: boolean;
}

export default function EnvironmentPanel({
  state,
  request,
  onSaved,
}: {
  state: SetupState;
  request: <T>(path: string, init?: RequestInit) => Promise<T>;
  onSaved: () => void;
}) {
  /** Only fields the user typed into. Untouched secrets never get sent back. */
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<SaveResult | null>(null);

  // Edits are cleared explicitly after a successful save, not synced from a
  // refetch. A manual Refresh with unsaved edits should keep them — losing
  // typed-in credentials to a background refresh is worse than showing a value
  // that is momentarily ahead of the file.
  const dirty = Object.keys(edits).length > 0;

  const byGroup = useMemo(() => {
    const map = new Map<string, SetupField[]>();
    for (const field of state.fields) {
      const list = map.get(field.group) ?? [];
      list.push(field);
      map.set(field.group, list);
    }
    return map;
  }, [state.fields]);

  function displayValue(field: SetupField): string {
    if (field.name in edits) return edits[field.name];
    if (field.name in revealed) return revealed[field.name];
    return field.value;
  }

  function isMasked(field: SetupField): boolean {
    return (
      field.secret &&
      field.isSet &&
      !(field.name in edits) &&
      !(field.name in revealed)
    );
  }

  async function reveal(field: SetupField) {
    const payload = await request<{ success: boolean; data?: { value: string } }>(
      "/api/setup/env",
      { method: "PUT", body: JSON.stringify({ name: field.name }) }
    );
    if (payload.success && payload.data) {
      setRevealed((current) => ({ ...current, [field.name]: payload.data!.value }));
    }
  }

  async function generate(field: SetupField) {
    const payload = await request<{ success: boolean; data?: { value: string } }>(
      "/api/setup/generate",
      { method: "POST", body: JSON.stringify({ name: field.name }) }
    );
    if (payload.success && payload.data) {
      setEdits((current) => ({ ...current, [field.name]: payload.data!.value }));
      setResult(null);
    }
  }

  async function save() {
    setSaving(true);
    setResult(null);
    setFieldErrors({});

    try {
      const payload = await request<{
        success: boolean;
        error?: string;
        errors?: Record<string, string>;
        data?: { saved: string[]; restartRequired: boolean; backupPath: string | null };
      }>("/api/setup/env", {
        method: "POST",
        body: JSON.stringify({ updates: edits }),
      });

      if (!payload.success) {
        setFieldErrors(payload.errors ?? {});
        setResult({ ok: false, message: payload.error ?? "Could not save" });
        return;
      }

      const count = payload.data?.saved.length ?? 0;
      setResult({
        ok: true,
        message: `Saved ${count} value${count === 1 ? "" : "s"} to .env${
          payload.data?.backupPath ? " (previous contents backed up)" : ""
        }.`,
        restartRequired: payload.data?.restartRequired,
      });
      setEdits({});
      setRevealed({});
      onSaved();
    } catch (error) {
      setResult({
        ok: false,
        message: error instanceof Error ? error.message : "Could not save",
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <Panel
        title="Environment"
        description={`Written to ${state.envFile.path}. Values you have not touched are left exactly as they are, comments and all.`}
        actions={
          <>
            <Button
              variant="ghost"
              onClick={() => {
                setEdits({});
                setFieldErrors({});
                setResult(null);
              }}
              disabled={!dirty || saving}
            >
              Discard
            </Button>
            <Button variant="primary" onClick={() => void save()} disabled={!dirty || saving}>
              {saving ? "Saving…" : dirty ? `Save ${Object.keys(edits).length}` : "Saved"}
            </Button>
          </>
        }
      >
        {result && (
          <div className="mb-5 space-y-3">
            <Callout tone={result.ok ? "success" : "error"}>{result.message}</Callout>
            {result.restartRequired && (
              <Callout tone="warn" title="Restart needed">
                <p>
                  Connection strings and secrets are read once at boot. Restart
                  the dev server for these to take effect.
                </p>
                <div className="mt-2 max-w-md">
                  <CodeLine>npm run dev</CodeLine>
                </div>
              </Callout>
            )}
          </div>
        )}

        <div className="space-y-8">
          {state.groups.map((group) => {
            const fields = byGroup.get(group.id) ?? [];
            if (fields.length === 0) return null;

            return (
              <div key={group.id}>
                <h3 className="text-sm font-semibold text-foreground">
                  {group.title}
                </h3>
                <p className="mt-1 max-w-2xl text-sm text-muted">
                  {group.description}
                </p>

                <div className="mt-4 space-y-5">
                  {fields.map((field) => {
                    const value = displayValue(field);
                    const masked = isMasked(field);
                    const error = fieldErrors[field.name] ?? field.error;
                    const edited = field.name in edits;

                    return (
                      <div
                        key={field.name}
                        className="rounded border border-border bg-background/40 p-4"
                      >
                        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                          <div className="flex items-baseline gap-2">
                            <span className="font-mono text-xs text-muted">
                              {field.name}
                            </span>
                            {field.required && (
                              <span className="text-xs font-semibold text-warning">
                                required
                              </span>
                            )}
                            {edited && (
                              <span className="text-xs font-semibold text-accent">
                                edited
                              </span>
                            )}
                          </div>
                          <div className="flex gap-3">
                            {field.generator && (
                              <button
                                type="button"
                                onClick={() => void generate(field)}
                                className="text-xs font-semibold text-accent hover:text-accent-hover"
                              >
                                Generate
                              </button>
                            )}
                            {masked && (
                              <button
                                type="button"
                                onClick={() => void reveal(field)}
                                className="text-xs font-semibold text-accent hover:text-accent-hover"
                              >
                                Reveal
                              </button>
                            )}
                          </div>
                        </div>

                        <Field
                          label={field.label}
                          htmlFor={`env-${field.name}`}
                          hint={field.help}
                          error={error}
                        >
                          {field.options ? (
                            <select
                              id={`env-${field.name}`}
                              value={value}
                              onChange={(event) =>
                                setEdits((current) => ({
                                  ...current,
                                  [field.name]: event.target.value,
                                }))
                              }
                              className={inputClass}
                            >
                              <option value="">Use the default</option>
                              {field.options.map((option) => (
                                <option key={option} value={option}>
                                  {option}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <input
                              id={`env-${field.name}`}
                              type="text"
                              spellCheck={false}
                              autoComplete="off"
                              value={value}
                              placeholder={field.placeholder ?? ""}
                              onChange={(event) =>
                                setEdits((current) => ({
                                  ...current,
                                  [field.name]: event.target.value,
                                }))
                              }
                              onFocus={() => {
                                // Typing over a mask would save the mask. Clear
                                // it the moment the field is focused instead.
                                if (masked) {
                                  setEdits((current) => ({ ...current, [field.name]: "" }));
                                }
                              }}
                              className={`${inputClass} ${
                                field.secret ? "font-mono" : ""
                              }`}
                            />
                          )}
                        </Field>

                        {field.warning && !error && (
                          <p className="mt-2 text-xs text-warning">{field.warning}</p>
                        )}
                        {field.source && (
                          <p className="mt-1.5 text-xs text-muted">
                            Where to find it:{" "}
                            <span className="font-mono">{field.source}</span>
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </Panel>
    </div>
  );
}
