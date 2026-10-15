# Harvey × OpenReply — build log

Running record of what was decided, why, what was tested, and what is assumed.
Written as the work happened. The architecture plan lives in
`harvey-fusion-plan.md`; this file is the reasoning and evidence behind it.

Started 2026-10-14. Harvey upstream pinned at `e2632eb` (2026-10-13, MIT).

---

## 1. What the two systems actually are

| | OpenReply | Harvey |
|---|---|---|
| Direction | **Inbound.** They comment, we reply. | **Outbound.** We find them, we write first. |
| Stack | Next.js 16, Prisma 7, Postgres, BullMQ/Redis | Python 3.11+, SQLite, FastAPI |
| Runs on | Vercel + Railway (cloud, always up) | The operator's own machine |
| Model cost | none (no LLM in the loop today) | none — shells out to the logged-in Claude CLI |
| Size | ~30 API routes, 18 dashboard pages | 16.8k LOC, 66 files, 5 sub-agents |

They are not competitors and they do not overlap. One ends where the other
begins, which is why this fusion is worth doing at all.

## 2. Ideas considered

Recorded whether used or not, because the rejected ones explain the shape of
the accepted one.

### 2.1 Port Harvey to TypeScript inside OpenReply — REJECTED
16.8k LOC, and `harvey/agents/scout.py` alone is 1873 lines of prompt
engineering and scoring. Porting it means owning it: every upstream fix,
every new signal collector, re-translated by hand forever. Worse, the port
cannot keep Harvey's single best property — the model backend is the
operator's **Claude Code CLI subprocess** (`harvey/brain.py`), so there is no
per-token bill. Vercel functions cannot shell out to a logged-in CLI. A port
would have to reintroduce a metered API key, which is the one cost this whole
exercise avoids.

### 2.2 Harvey as a Railway service — REJECTED for now
Same blocker from the other side: `brain.py` needs an interactive
`claude login` session. Running that in a container means either baking
credentials into an image or accepting that every redeploy logs you out.
Recorded as a future option if Harvey's Codex provider turns out to be
headless-friendly.

### 2.3 CSV bridge — REJECTED as the ceiling, kept as the floor
Harvey already has `harvey export`. Wiring that into OpenReply's existing
campaign importer would take an afternoon and produce a one-way, manual,
unattributed hand-off. It is the baseline any real design has to beat, not a
design.

### 2.4 Harvey local + OpenReply as cloud control plane — CHOSEN DIRECTION
Harvey stays where the CLI is logged in. OpenReply becomes the system of
record and the only screen the operator looks at. Traffic is one-way by
construction: **Harvey pushes what it learned, and polls for what the operator
decided.** No inbound port on the home network, no tunnel, nothing to expose.
The operator approves cold emails from a phone in Kampala while the Mac does
the work.

### 2.5 The closed attribution loop — THE REASON THIS IS A FUSION
OpenReply already runs this exact machinery for Instagram, and it already
works in production:

```
tracked link /r/<slug>  →  LinkClick row  →  redirect to wa.me with "(ref: {ref})"
                        →  OpenWA webhook  →  extractRefSlug()  →  WhatsAppLead.refSlug
```

A Harvey cold email that carries one `/r/<slug>` link inherits all of it. The
reply does not have to come back as email — it can land in WhatsApp, already
attributed to the company, the campaign and the sequence step, and the existing
auto-reply fires. Zero new attribution code. This is reuse, not integration.

**Constraint found while reading `prompts/writer.md`:** Harvey's own rules say
"No links in email 1. At most one link total across the sequence", and
`harvey/gate.py` enforces `MAX_LINKS = 1` at send time. So the tracked link
belongs at step 2 or 3, or in a Handler reply ("reply and I'll send the
wholesale list"). That is also the better funnel: the link goes to someone who
already answered. The constraint improved the design.

### 2.6 OpenReply signals as Harvey observations — ACCEPTED, with a catch
Harvey's data principle is "every fact is a row, never a column":
`observations(company_id, signal_code, value, confidence, evidence_url, …)`,
with a SQLite trigger refusing any `signal_code` absent from the governed
`signal_codes` table. OpenReply knows things Harvey cannot discover — this
business commented on our post, clicked, opened a WhatsApp chat, went quiet.
Pushing those in as observations lets Scout score a prospect who is *already
warm*, which is strictly better than scoring them cold.
The catch: new codes must be inserted into `signal_codes` with
`status = 'confirmed'` or the trigger rejects every write. That is a required
migration step on the Harvey side, not optional.

### 2.7 "Inbound lead goes cold → Harvey emails them" — NOT POSSIBLE AS STATED
Worth recording because it sounds obvious and is wrong. An Instagram commenter
gives us an Instagram handle and, at best, a WhatsApp number. **We never get
their email address.** Harvey sends email. So the direct hand-off does not
exist.

What *is* possible, and is the honest version: when the lead is a **business**
(a boutique, a gym, a reseller), its handle and name are enough to seed
Harvey's DISCOVER/PROFILE stages, which find the website and then the address
through the normal enrichment path. So the reverse flow is a *seed*, not a
hand-off. Any plan claiming otherwise is overselling.

### 2.8 Harvey's Brain as OpenReply's LLM — PARKED, DELIBERATELY
Harvey holds a budgeted, rate-limited, already-working path to a Claude model
with no API bill. OpenReply has no LLM anywhere today. The command queue built
for approvals could just as easily carry `brain.draft_reply` work, giving
OpenReply's Instagram inbox AI-drafted replies for free. Genuinely the biggest
unlock here, and out of scope for the first ship. Parked in writing so it is
not forgotten.

## 3. Compliance decisions (not negotiable, decided before any code)

| Channel | Decision | Why |
|---|---|---|
| Outbound Instagram DM to non-followers | **Never build it.** | The Graph API only permits replies inside a 24h/7-day window. There is no API that sends a cold IG DM. Any feature needing it is a ban waiting to happen. |
| Outbound WhatsApp to strangers via OpenWA | **Never build it.** | Unofficial gateway + unsolicited first contact is the fastest way to lose the number. WhatsApp stays **inbound-only**: the prospect opens the chat by tapping our link. |
| Cold email | **The one legitimate outbound channel.** | Angelo is the sender and carries CAN-SPAM/GDPR responsibility. Needs a dedicated sending domain, SPF/DKIM/DMARC, and warm-up before volume. |
| LinkedIn automation | **Stays off.** | Harvey ships it disabled because it breaks LinkedIn's terms. Left disabled. |

## 4. Host prerequisites, verified on this machine

| Requirement | Status |
|---|---|
| Python 3.11+ | `python3.12` → 3.12.12. **`python3` is 3.9.6 and will not work** — every Harvey command must use `python3.12`. |
| Claude CLI logged in | `claude` 2.1.300 present at `~/.local/bin/claude` |
| Playwright browsers (Harvey dep) | already cached, 1.1 GB in `~/Library/Caches/ms-playwright` |
| GitHub auth | `gh` authenticated as `angellog` |
| Free disk | **2.7 GB of 228 GB. 99% full.** Flagged: this is the likeliest cause of OpenReply's `node_modules` disappearing four times. |

## 5. Schema blast radius, measured not guessed

A cold email has no Instagram account, but `TrackedLink.automationId`,
`LinkClick.automationId` and `LinkClick.instagramAccountId` are all NOT NULL,
and `Automation.instagramAccountId` is NOT NULL too.

Three ways out were considered. A synthetic placeholder `Automation` was
rejected: it would appear in campaign lists, funnel rows and reports as a fake
Instagram campaign, corrupting exactly the numbers this feature exists to
produce. Making the columns nullable was chosen instead, and the blast radius
was then measured rather than assumed:

- `lib/reports/data.ts`, `app/api/whatsapp/funnel/route.ts` — every query
  filters *by* a specific `automationId`, so rows with `NULL` simply never
  match. No change needed.
- `lib/whatsapp/inbound.ts` — **already** handles a null automation and null
  Instagram account (`?? null` at lines 111-112, 125), because `WhatsAppLead`
  made them optional for multi-number support.
- `app/r/[slug]/route.ts` — the only file that must change. It writes both
  columns unconditionally today.

So: one route to edit, two columns to relax. The inbound half of the
attribution loop needs no changes at all.

## 6. Tests written so far

| Test | What it proves |
|---|---|
| `__tests__/harvey-signature.test.ts` (19) | HMAC accepts a good request; rejects tampered body, moved timestamp, wrong secret, missing headers, 5 malformed timestamp shapes, and a short signature (no throw from `timingSafeEqual`); accepts drift inside ±300s and rejects one second past it. |
| `tests/test_openreply_bridge.py` (10) | Canonical body is byte-stable regardless of dict key order; signature covers both body and timestamp; headers send exactly what was signed; unconfigured client refuses to call out. |
| **golden vector, in both suites** | Python and TypeScript produce the identical digest for one frozen body/timestamp/secret. If either side changes its signed material, a test fails instead of the bridge 401-ing in production. |

Baseline before this work: 175 tests / 18 files green. After: **194 / 19 green.**

## 7. Assumptions, flagged

1. **Harvey runs on the Mac, which sleeps.** Approvals must survive it. A
   queued command has to be safe to deliver three days late, and an outbox item
   approved a week ago has stale personalization — it should need re-approval,
   not silently send. Must be designed for, not hoped away.
2. **One Harvey node per workspace.** Harvey is single-tenant; OpenReply is
   workspace-scoped. The node carries the workspace, and every row it pushes
   inherits it.
3. **The operator owns the Claude quota.** Harvey's `max_daily_claude_percent`
   is a cap on Angelo's own subscription. If OpenReply later borrows the Brain
   (§2.8), the two uses compete for one budget.
4. **Email deliverability is unproven here.** No dedicated sending domain
   exists yet. Until SPF/DKIM/DMARC are in place on a domain that is not the
   main business domain, volume stays near zero regardless of what the software
   can do.
5. **Harvey upstream is young** (0.3.0, repo days old at pin time). The fork
   stays a thin addition in `harvey/integrations/` so upstream merges stay
   cheap.

---

## 8. Reconciliation with the architecture review

The plan in `harvey-fusion-plan.md` was produced independently and reviewed
against what had already been built. It converged on the same architecture
(Harvey local, OpenReply as control plane, outbound-only traffic, the tracked
link as the attribution join), which is reassuring, and it caught three things
worth changing.

### Taken from the review

1. **One agent per brand, not one per workspace.** The original schema had
   `@@unique([workspaceId])` on the agent. Angelo runs two outreach motions —
   sneaker wholesale and advisory — with different senders, offers and
   handoffs. They are different agents sharing one workspace, so the
   constraint became `@@unique([workspaceId, name])`. This was a genuine
   modelling error, not a preference.
2. **Handoff destinations belong on the agent.** Originally the mint request
   carried the phone number. Holding it on the agent instead means a stolen
   Harvey secret cannot repoint a link on our own domain at an arbitrary
   number, and it is what makes "WhatsApp for FeetBit, Cal.com for Vantik"
   configuration rather than code.
3. **A real bug.** `app/api/dashboard/stats/route.ts` counts every `LinkClick`
   in the workspace. With no account selected its filter is empty, so
   cold-email clicks would have silently inflated the Instagram dashboard's
   click metric. Fixed with `automationId: { not: null }`, and the same filter
   added to the funnel's `groupBy` to make the exclusion explicit rather than
   incidental.

Also adopted: `/api/harvey/v1/*` for agent traffic and `/api/outreach/*` for
operator traffic (versioning the wire protocol, and keeping the two auth modes
out of one path prefix); `secretPrefix` so the operator can identify a secret
without it being retrievable; `HarveyAgentStatus` so an agent can be revoked
without deleting its history; a dedicated `HARVEY` value on
`OperationalEventSource`; and `EDIT_EMAIL` / `APPROVE_ALL` commands.

### Kept against the review, with reasons

1. **`HarveyCompany` stays a table.** The review denormalised company fields
   onto the prospect. Harvey's own model is company-first — its `observations`
   hang off a company id — and "which boutiques do we know, and who have we
   reached at each" is the question B2B outreach exists to answer. A real
   table answers it without string-matching company names.
2. **Five outbox statuses, not six.** The review added `REJECTED`. Harvey has
   no such status; a rejection is its `cancelled` with a reason. Inventing a
   sixth state in a mirror is how a mirror starts lying. The reason goes in
   `error`, which Harvey already displays.
3. **Timestamps, not a command-status enum.** `deliveredAt` / `ackedAt` /
   `expiresAt` carry strictly more information than `PENDING | DELIVERED |
   ACKED | EXPIRED` and cannot contradict each other the way a status column
   and its timestamps can.
4. **One fused sync endpoint** instead of separate heartbeat / sync /
   commands-pull / commands-ack calls. Push, ack and collect happen in one
   request per cycle, in that order, so Harvey's work is recorded and its old
   orders closed out before new ones are handed over — and a heartbeat is one
   round trip rather than four. All fields are optional, so an
   acks-only or empty call is a valid heartbeat.
5. **No `python@3.13` install.** The review reported no Python 3.11-3.13 on
   this machine. There is: `python3.12` is 3.12.12. Verified directly.

## 9. Two bugs found in my own work, both by writing the test

1. **Mutable class attribute.** `OpenReplyBridge._pending_acks` was declared at
   class level, so every bridge in a process would have shared one list and
   acked each other's commands. Moved into `__init__`.
2. **Mixed timestamp spellings, the subtle one.** Harvey's database contains
   both `2026-10-15 09:00:00` (SQLite `CURRENT_TIMESTAMP`) and
   `2026-10-15T09:00:00.123` (Python `isoformat()`). Compared as strings, `T`
   (0x54) sorts above a space (0x20) — so an ISO-stamped row at midnight looks
   *newer* than a space-stamped row at 23:59 the same day. A cursor taken from
   the first would have skipped the second permanently, and the rows would
   simply never have synced. `get_rows_updated_since` now normalises the
   separator on both sides of the comparison, and there is a test pinning it.

The same discipline caught two wrong *tests* rather than wrong code: an empty
header is "missing" rather than "malformed", and a fake `encryptToken` that
echoed its input made the "secret is never stored in the clear" assertion
vacuous.

## 10. What is built, and what is not

Shipped and green — 244 tests across 23 files in OpenReply, 46 in Harvey,
typecheck and lint clean, production build passing:

| Piece | Where |
|---|---|
| Request signing, both languages, pinned by a shared golden vector | `lib/harvey/signature.ts`, `harvey/integrations/openreply.py` |
| Agent authentication, revocation, deduped failure logging | `lib/harvey/auth.ts` |
| The sync endpoint: push, ack, collect in one round trip | `app/api/harvey/v1/sync/route.ts` |
| Link minting, idempotent per email, destination from the agent | `app/api/harvey/v1/links/route.ts` |
| Pairing, rotation, revocation, handoff config | `app/api/outreach/agents/route.ts` |
| The approvals desk and its decision queue | `app/api/outreach/outbox/route.ts`, `app/(dashboard)/outreach/page.tsx` |
| Harvey's bridge loop, body rewriting, command application | `harvey/integrations/openreply.py` |
| Incremental reads with a format-safe cursor | `harvey/state.py` |
| Operator guide | `docs/harvey.md` |

Deliberately not built yet, in the order I would do it:

1. **`POST /api/harvey/v1/events` — the reverse flow.** Harvey currently
   pushes and receives decisions, but learns nothing from what happens after a
   send. This endpoint would let it pull `LINK_CLICKED`, `WHATSAPP_STARTED`
   and `WHATSAPP_MESSAGE_IN` as `observations`, which gives it two things it
   cannot get elsewhere: stop-on-reply when a prospect answers on WhatsApp
   instead of email, and Scout scoring a business that is already engaging.
   Needs an `OutreachEvent` table with a monotonic cursor and five new
   `signal_codes` rows seeded as confirmed (Harvey's trigger rejects unknown
   codes).
2. **Timeline per prospect.** Merging emails, clicks and WhatsApp messages into
   one chronology. The data is already all there; this is a read model.
3. **Lead handoff from inbound to outbound.** Not "email the Instagram
   commenter" — see §2.7, we never have their address — but seeding Harvey's
   DISCOVER stage from a business that engaged on Instagram.
4. **Borrowing Harvey's brain** (§2.8) for drafting Instagram replies.

Phase 1 is the whole loop end to end: Harvey writes, you approve from your
phone, Harvey sends with a tracked link, the prospect lands in WhatsApp
attributed. Each item above makes it smarter; none is needed for it to work.

## 11. Verification on the real runner

The venv was installed by the operator (auto mode would not execute setup code
from a freshly cloned external repo), so the Harvey side now has real evidence
rather than a stand-in:

| Suite | Result |
|---|---|
| `pytest tests/test_openreply_bridge.py` | **46 passed** in 0.07s — identical to the stub-based run, so that earlier result stands |
| `pytest` (all of Harvey) | **474 passed, 19 skipped** |
| OpenReply `npm test` | **246 passed, 23 files**; typecheck and lint clean |

The full Harvey suite first came back `473 passed, 1 failed`:
`test_brain_provider.py::test_existing_usage_rows_become_claude`. It was not a
regression from this work. Proof: it fails identically on pristine upstream
`e2632eb` in a separate worktree, verified by printing `harvey.__file__` to
confirm which tree was imported.

The cause is worth recording because it is invisible most of the day. The
fixture seeded `usage_log` with SQLite's `date('now')`, which is **UTC**, while
`get_usage_today()` and `increment_usage()` both key that table on Python's
**local** `date.today()`. Those disagree for part of every day in any non-UTC
zone: just after local midnight east of UTC, and in the evening west of it. At
01:30 in Kampala (UTC+3), `date('now')` was still 2026-10-14 while
`date.today()` was 2026-10-15, so the row was written under one date and read
under another.

Production is self-consistent, since the writer and the reader both use the
local date. Only the fixture reached for UTC. Fixed in its own commit
(`a42fc56`) so it can be offered upstream on its own.
