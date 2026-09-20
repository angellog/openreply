"use client";

/**
 * Connected accounts, and the targets pointed at them.
 *
 * A target is one Instagram account plus the post(s) to watch, the keywords
 * that trigger it, and what gets sent back. These are the same records the
 * dashboard calls campaigns, so anything added here appears there too.
 */

import { useCallback, useEffect, useState } from "react";
import {
  Button,
  Callout,
  EmptyState,
  Field,
  Panel,
  StatusDot,
  inputClass,
} from "@/components/setup/ui";
import type {
  InstagramPost,
  SetupState,
  TabId,
  TargetTrigger,
} from "@/components/setup/types";

const TRIGGERS: { id: TargetTrigger; label: string; help: string }[] = [
  {
    id: "specific_post",
    label: "One specific post",
    help: "Only comments on the post you pick will trigger this.",
  },
  {
    id: "any_post",
    label: "Any post on the account",
    help: "Every post, including ones you publish later. Broad — pair it with distinctive keywords.",
  },
  {
    id: "next_reel",
    label: "The next reel you post",
    help: "Binds itself to the next reel published on this account, then behaves like a specific-post target.",
  },
];

interface DraftTarget {
  name: string;
  instagramAccountId: string;
  trigger: TargetTrigger;
  postId: string;
  postUrl: string;
  keywordText: string;
  matchAnyWord: boolean;
  wholeWordMatch: boolean;
  dmMessage: string;
  publicReplyEnabled: boolean;
  publicReplyText: string;
  trackedDestinationUrl: string;
  isActive: boolean;
}

function emptyDraft(accountId: string): DraftTarget {
  return {
    name: "",
    instagramAccountId: accountId,
    trigger: "specific_post",
    postId: "",
    postUrl: "",
    keywordText: "",
    matchAnyWord: false,
    wholeWordMatch: true,
    dmMessage: "Hey {username}! Here's the link you asked for: ",
    publicReplyEnabled: false,
    publicReplyText: "Just sent it over — check your DMs!",
    trackedDestinationUrl: "",
    isActive: true,
  };
}

export default function TargetsPanel({
  state,
  request,
  onChanged,
  onNavigate,
}: {
  state: SetupState;
  request: <T>(path: string, init?: RequestInit) => Promise<T>;
  onChanged: () => void;
  onNavigate: (tab: TabId) => void;
}) {
  const accounts = state.accounts;
  const [draft, setDraft] = useState<DraftTarget>(() =>
    emptyDraft(accounts[0]?.id ?? "")
  );
  const [posts, setPosts] = useState<InstagramPost[] | null>(null);
  const [postsError, setPostsError] = useState<string | null>(null);
  const [loadingPosts, setLoadingPosts] = useState(false);
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  // Derived, not synced: if the draft's account has been disconnected since it
  // was chosen, fall back to the first one that still exists. Storing this in an
  // effect would mean a render where the form points at an account that is gone.
  const selectedAccountId = accounts.some(
    (account) => account.id === draft.instagramAccountId
  )
    ? draft.instagramAccountId
    : (accounts[0]?.id ?? "");

  type PostsResponse = {
    success: boolean;
    error?: string;
    data?: InstagramPost[];
  };

  const requestPosts = useCallback(
    (accountId: string) =>
      request<PostsResponse>(
        `/api/instagram/posts?instagramAccountId=${encodeURIComponent(accountId)}&limit=25`
      ),
    [request]
  );

  const applyPosts = useCallback((payload: PostsResponse) => {
    if (payload.success && payload.data) setPosts(payload.data);
    else setPostsError(payload.error ?? "Could not load posts");
  }, []);

  const applyPostsError = useCallback((error: unknown) => {
    setPostsError(error instanceof Error ? error.message : "Could not load posts");
  }, []);

  async function reloadPosts() {
    if (!selectedAccountId) return;
    setLoadingPosts(true);
    setPostsError(null);
    try {
      applyPosts(await requestPosts(selectedAccountId));
    } catch (error) {
      applyPostsError(error);
    } finally {
      setLoadingPosts(false);
    }
  }

  // Load the picker's posts the first time a specific-post target needs them.
  // Every state update happens in a promise callback, never in the effect body,
  // and a response for an account you have since switched away from is dropped.
  const needsPosts =
    draft.trigger === "specific_post" && Boolean(selectedAccountId) && !posts;

  useEffect(() => {
    if (!needsPosts) return;
    let active = true;
    requestPosts(selectedAccountId)
      .then((payload) => {
        if (active) applyPosts(payload);
      })
      .catch((error: unknown) => {
        if (active) applyPostsError(error);
      })
      .finally(() => {
        if (active) setLoadingPosts(false);
      });
    return () => {
      active = false;
    };
  }, [needsPosts, selectedAccountId, requestPosts, applyPosts, applyPostsError]);

  async function createTarget() {
    setBusy(true);
    setErrors({});
    setMessage(null);

    const keywords = draft.keywordText
      .split(/[,\n]/)
      .map((keyword) => keyword.trim())
      .filter(Boolean);

    const publicReplyMessages = draft.publicReplyText
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    try {
      const payload = await request<{
        success: boolean;
        error?: string;
        errors?: Record<string, string[]>;
      }>("/api/setup/targets", {
        method: "POST",
        body: JSON.stringify({
          name: draft.name,
          instagramAccountId: selectedAccountId,
          trigger: draft.trigger,
          postId: draft.postId || null,
          postUrl: draft.postUrl || "",
          keywords,
          matchAnyWord: draft.matchAnyWord,
          wholeWordMatch: draft.wholeWordMatch,
          dmMessage: draft.dmMessage,
          publicReplyEnabled: draft.publicReplyEnabled,
          publicReplyMessages,
          trackedDestinationUrl: draft.trackedDestinationUrl || "",
          isActive: draft.isActive,
        }),
      });

      if (!payload.success) {
        setErrors(payload.errors ?? {});
        setMessage({ ok: false, text: payload.error ?? "Could not create the target" });
        return;
      }

      setDraft(emptyDraft(selectedAccountId));
      setMessage({ ok: true, text: "Target created. It is live immediately." });
      onChanged();
    } catch (error) {
      setMessage({
        ok: false,
        text: error instanceof Error ? error.message : "Could not create the target",
      });
    } finally {
      setBusy(false);
    }
  }

  async function toggleTarget(id: string, isActive: boolean) {
    await request(`/api/setup/targets?id=${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ isActive }),
    });
    onChanged();
  }

  async function removeTarget(id: string, name: string) {
    if (!window.confirm(`Delete the target "${name}"? Its DM logs go with it.`)) {
      return;
    }
    await request(`/api/setup/targets?id=${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    onChanged();
  }

  async function disconnect(accountId: string, username: string) {
    if (
      !window.confirm(
        `Disconnect @${username}? Targets pointed at it are deleted too.`
      )
    ) {
      return;
    }
    await request("/api/instagram/disconnect", {
      method: "POST",
      body: JSON.stringify({ instagramAccountId: accountId }),
    });
    onChanged();
  }

  const signedIn = Boolean(state.session);
  const fieldError = (key: string) => errors[key]?.[0] ?? null;

  return (
    <div className="space-y-6">
      <Panel
        title="Instagram accounts"
        description="Each connected account has its own token and its own rate-limit budget. Connect as many as you run."
        actions={
          <Button
            variant="primary"
            onClick={() => {
              window.location.href = "/api/instagram/connect";
            }}
            disabled={!signedIn}
          >
            Connect an account
          </Button>
        }
      >
        {!signedIn && (
          <div className="mb-4">
            <Callout tone="warn" title="Sign in first">
              <p>
                Connecting an account runs an OAuth flow that needs a signed-in
                session.{" "}
                <button
                  type="button"
                  onClick={() => onNavigate("signin")}
                  className="font-semibold text-accent hover:text-accent-hover"
                >
                  Create a local session
                </button>{" "}
                — it takes one click and does not need Resend.
              </p>
            </Callout>
          </div>
        )}

        {accounts.length === 0 ? (
          <EmptyState>
            No Instagram accounts connected yet. It must be a Business or Creator
            account — a personal one cannot be connected.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-border">
            {accounts.map((account) => (
              <li
                key={account.id}
                className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
              >
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-foreground">
                    @{account.username}
                  </p>
                  <p className="mt-0.5 flex flex-wrap items-center gap-x-3 text-xs text-muted">
                    <span className="font-mono">{account.instagramId}</span>
                    <span className="flex items-center gap-1.5">
                      <StatusDot
                        status={account.webhookSubscribed ? "ok" : "warn"}
                      />
                      {account.webhookSubscribed
                        ? "Subscribed to comments"
                        : "Not subscribed — reconnect to fix"}
                    </span>
                    {account.tokenExpiresAt && (
                      <span>
                        Token expires{" "}
                        {new Date(account.tokenExpiresAt).toLocaleDateString()}
                      </span>
                    )}
                  </p>
                </div>
                <Button
                  variant="danger"
                  onClick={() => void disconnect(account.id, account.username)}
                >
                  Disconnect
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel
        title="Targets"
        description={`${state.targets.length} target${
          state.targets.length === 1 ? "" : "s"
        } across ${accounts.length} account${accounts.length === 1 ? "" : "s"}. These are the same records the dashboard calls campaigns.`}
      >
        {state.targets.length === 0 ? (
          <EmptyState>
            Nothing is being watched yet. Add a target below.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-border">
            {state.targets.map((target) => (
              <li key={target.id} className="py-4 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <StatusDot status={target.isActive ? "ok" : "skipped"} />
                      <p className="text-sm font-semibold text-foreground">
                        {target.name}
                      </p>
                      <span className="text-xs text-muted">
                        {target.account ? `@${target.account.username}` : "no account"}
                        {" · "}
                        {target.triggerLabel}
                      </span>
                    </div>

                    <p className="mt-2 text-xs text-muted">
                      {target.matchAnyWord ? (
                        <span className="text-warning">Matches any comment</span>
                      ) : (
                        <>
                          Keywords:{" "}
                          <span className="font-mono text-foreground">
                            {target.keywords.join(", ")}
                          </span>
                          {target.wholeWordMatch ? " (whole word)" : " (partial)"}
                        </>
                      )}
                    </p>
                    <p className="mt-1 truncate text-xs text-muted">
                      DM: {target.dmMessage}
                    </p>
                    {target.trackedUrl && (
                      <p className="mt-1 truncate text-xs text-muted">
                        Tracked link:{" "}
                        <span className="font-mono">{target.trackedUrl}</span>
                      </p>
                    )}
                    <p className="mt-1 text-xs text-muted">
                      {target.stats.sent} sent · {target.stats.skipped} skipped ·{" "}
                      {target.stats.failed} failed
                    </p>
                  </div>

                  <div className="flex shrink-0 gap-2">
                    <Button
                      onClick={() => void toggleTarget(target.id, !target.isActive)}
                    >
                      {target.isActive ? "Pause" : "Activate"}
                    </Button>
                    <Button
                      variant="danger"
                      onClick={() => void removeTarget(target.id, target.name)}
                    >
                      Delete
                    </Button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel
        title="Add a target"
        description="What to watch, what to look for, and what to send back."
      >
        {accounts.length === 0 ? (
          <Callout tone="warn">
            Connect an Instagram account first — a target has to point at one.
          </Callout>
        ) : (
          <div className="space-y-5">
            {message && (
              <Callout tone={message.ok ? "success" : "error"}>{message.text}</Callout>
            )}

            <div className="grid gap-5 sm:grid-cols-2">
              <Field
                label="Name"
                htmlFor="target-name"
                hint="Just for you — it labels the target in logs and reports."
                error={fieldError("name")}
              >
                <input
                  id="target-name"
                  value={draft.name}
                  onChange={(event) =>
                    setDraft({ ...draft, name: event.target.value })
                  }
                  placeholder="Launch reel — LINK"
                  className={inputClass}
                />
              </Field>

              <Field label="Account" htmlFor="target-account">
                <select
                  id="target-account"
                  value={selectedAccountId}
                  onChange={(event) => {
                    setDraft({ ...draft, instagramAccountId: event.target.value });
                    setPosts(null);
                  }}
                  className={inputClass}
                >
                  {accounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      @{account.username}
                    </option>
                  ))}
                </select>
              </Field>
            </div>

            <fieldset>
              <legend className="text-sm font-semibold text-foreground">
                What triggers it
              </legend>
              <div className="mt-2 space-y-2">
                {TRIGGERS.map((trigger) => (
                  <label
                    key={trigger.id}
                    className="flex cursor-pointer gap-3 rounded border border-border bg-background/40 p-3"
                  >
                    <input
                      type="radio"
                      name="target-trigger"
                      checked={draft.trigger === trigger.id}
                      onChange={() => setDraft({ ...draft, trigger: trigger.id })}
                      className="mt-0.5 h-4 w-4 accent-[var(--color-accent)]"
                    />
                    <span>
                      <span className="block text-sm font-semibold text-foreground">
                        {trigger.label}
                      </span>
                      <span className="mt-0.5 block text-xs text-muted">
                        {trigger.help}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>

            {draft.trigger === "specific_post" && (
              <div className="rounded border border-border bg-background/40 p-4">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-semibold text-foreground">Pick the post</p>
                  <Button
                    variant="ghost"
                    onClick={() => void reloadPosts()}
                    disabled={loadingPosts}
                  >
                    {loadingPosts ? "Loading…" : "Reload posts"}
                  </Button>
                </div>

                {postsError && (
                  <p className="mt-2 text-xs text-warning">
                    {postsError}. Paste a media ID below instead.
                  </p>
                )}

                {posts && posts.length > 0 && (
                  <div className="mt-3 max-h-64 space-y-1 overflow-y-auto">
                    {posts.map((post) => (
                      <button
                        key={post.id}
                        type="button"
                        onClick={() =>
                          setDraft({
                            ...draft,
                            postId: post.id,
                            postUrl: post.permalink ?? "",
                          })
                        }
                        className={`flex w-full items-center gap-3 rounded border px-3 py-2 text-left transition ${
                          draft.postId === post.id
                            ? "border-accent bg-accent/10"
                            : "border-border hover:border-border-hover"
                        }`}
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm text-foreground">
                            {post.caption?.slice(0, 80) || "(no caption)"}
                          </span>
                          <span className="block text-xs text-muted">
                            {post.media_type ?? "POST"}
                            {post.timestamp
                              ? ` · ${new Date(post.timestamp).toLocaleDateString()}`
                              : ""}
                          </span>
                        </span>
                      </button>
                    ))}
                  </div>
                )}

                <div className="mt-4">
                  <Field
                    label="Media ID"
                    htmlFor="target-post-id"
                    hint="Filled in when you pick a post above. You can also paste a media ID directly."
                    error={fieldError("postId")}
                  >
                    <input
                      id="target-post-id"
                      value={draft.postId}
                      onChange={(event) =>
                        setDraft({ ...draft, postId: event.target.value })
                      }
                      placeholder="17912345678901234"
                      className={`${inputClass} font-mono`}
                    />
                  </Field>
                </div>
              </div>
            )}

            <Field
              label="Keywords"
              htmlFor="target-keywords"
              hint="Comma or newline separated, up to 10. A comment containing any of them triggers the DM."
              error={fieldError("keywords")}
            >
              <input
                id="target-keywords"
                value={draft.keywordText}
                onChange={(event) =>
                  setDraft({ ...draft, keywordText: event.target.value })
                }
                placeholder="LINK, SEND, GUIDE"
                disabled={draft.matchAnyWord}
                className={`${inputClass} disabled:opacity-50`}
              />
            </Field>

            <div className="flex flex-wrap gap-x-6 gap-y-3">
              <label className="flex cursor-pointer items-center gap-2 text-sm text-muted">
                <input
                  type="checkbox"
                  checked={draft.matchAnyWord}
                  onChange={(event) =>
                    setDraft({ ...draft, matchAnyWord: event.target.checked })
                  }
                  className="h-4 w-4 accent-[var(--color-accent)]"
                />
                Reply to any comment, whatever it says
              </label>
              <label className="flex cursor-pointer items-center gap-2 text-sm text-muted">
                <input
                  type="checkbox"
                  checked={draft.wholeWordMatch}
                  onChange={(event) =>
                    setDraft({ ...draft, wholeWordMatch: event.target.checked })
                  }
                  disabled={draft.matchAnyWord}
                  className="h-4 w-4 accent-[var(--color-accent)] disabled:opacity-50"
                />
                Whole-word match only
              </label>
            </div>

            <Field
              label="DM to send"
              htmlFor="target-dm"
              hint="Use {username} to greet the commenter by name."
              error={fieldError("dmMessage")}
            >
              <textarea
                id="target-dm"
                rows={3}
                value={draft.dmMessage}
                onChange={(event) =>
                  setDraft({ ...draft, dmMessage: event.target.value })
                }
                className={inputClass}
              />
            </Field>

            <Field
              label="Tracked link (optional)"
              htmlFor="target-link"
              hint="Swaps the URL in your DM for a redirect so clicks and CTR are counted."
              error={fieldError("trackedDestinationUrl")}
            >
              <input
                id="target-link"
                value={draft.trackedDestinationUrl}
                onChange={(event) =>
                  setDraft({ ...draft, trackedDestinationUrl: event.target.value })
                }
                placeholder="https://yoursite.com/offer"
                className={inputClass}
              />
            </Field>

            <div className="rounded border border-border bg-background/40 p-4">
              <label className="flex cursor-pointer items-center gap-2 text-sm font-semibold text-foreground">
                <input
                  type="checkbox"
                  checked={draft.publicReplyEnabled}
                  onChange={(event) =>
                    setDraft({ ...draft, publicReplyEnabled: event.target.checked })
                  }
                  className="h-4 w-4 accent-[var(--color-accent)]"
                />
                Also post a public reply under the comment
              </label>
              {draft.publicReplyEnabled && (
                <div className="mt-3">
                  <Field
                    label="Reply variations"
                    htmlFor="target-public-reply"
                    hint="One per line. A line is picked at random each time, so the replies do not all read identically."
                    error={fieldError("publicReplyMessages")}
                  >
                    <textarea
                      id="target-public-reply"
                      rows={3}
                      value={draft.publicReplyText}
                      onChange={(event) =>
                        setDraft({ ...draft, publicReplyText: event.target.value })
                      }
                      className={inputClass}
                    />
                  </Field>
                </div>
              )}
            </div>

            <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
              <label className="flex cursor-pointer items-center gap-2 text-sm text-muted">
                <input
                  type="checkbox"
                  checked={draft.isActive}
                  onChange={(event) =>
                    setDraft({ ...draft, isActive: event.target.checked })
                  }
                  className="h-4 w-4 accent-[var(--color-accent)]"
                />
                Start it active
              </label>
              <Button
                variant="primary"
                onClick={() => void createTarget()}
                disabled={busy}
              >
                {busy ? "Creating…" : "Add target"}
              </Button>
            </div>
          </div>
        )}
      </Panel>
    </div>
  );
}
