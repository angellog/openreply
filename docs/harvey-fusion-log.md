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
