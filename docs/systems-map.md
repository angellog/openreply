# Where every system lives

This is the written half of the systems map. The product shows the live
version at `/systems`; this file records the provenance and the seams — which
code came with the fork, which was fused in, and exactly where the two touch.

Everything below was read off the repository rather than remembered. The
commands are included so it can be re-checked rather than believed.

---

## 1. This is a fork, and the original is untouched

```
origin    https://github.com/angellog/openreply.git      (ours)
upstream  https://github.com/diwenne/openreply.git       (the open-source project)
```

GitHub confirms the relationship:

```bash
gh repo view angellog/openreply --json isFork,parent
# {"isFork": true, "parent": {"owner": {"login": "diwenne"}, "name": "openreply"}}
```

All work sits on the fork. As of this document `origin/main` is **25 commits
ahead** of `upstream/main`, and nothing has ever been pushed the other way.

**The push URL for `upstream` has been disabled** so a mistyped
`git push upstream` cannot reach the open-source repository:

```bash
git remote set-url --push upstream DISABLED_fetch_only
```

Fetching still works, so upstream changes can still be pulled in.

### One thing to know about this fork

It is **public**. GitHub does not allow a fork of a public repository to be
made private, so everything here — the Harvey bridge, the brand positioning,
the operating docs — is readable by anyone who finds it. No secrets are in the
repository (`.env*` is gitignored and every key is encrypted at rest in the
database), so nothing is *exposed*, but the strategy is legible.

If that matters, the fix is a fresh private repository rather than a fork:

```bash
gh repo create angellog/openreply-private --private
git remote add private https://github.com/angellog/openreply-private.git
git push private --all && git push private --tags
```

`upstream` stays as a remote either way, so upstream fixes can still be merged.
The cost is losing the fork link in GitHub's UI, which is cosmetic.

---

## 2. The five systems

| System | Origin | Runs on | Can it run on Vercel |
| --- | --- | --- | --- |
| Instagram DM | came with the fork | Vercel + Railway worker | partly — the worker cannot |
| WhatsApp | fused in | OpenWA container | no |
| Harvey | fused in | your Mac | no |
| Resource hub | fused in | Vercel | yes |
| Platform | came with the fork | Vercel + Postgres | yes |

Two of the five genuinely cannot run on Vercel, and that single fact explains
most of this stack's shape:

- **The DM worker** needs to remember what it sent a minute ago, because Meta's
  rate limits are per-account over time. A serverless function that forgets
  between invocations cannot do that.
- **Harvey** uses the operator's logged-in Claude Code CLI as its model
  backend. Those credentials live in the macOS Keychain and cannot be carried
  to a server. This is also why Harvey costs nothing per email.

The registry that encodes all of this is [`lib/systems/registry.ts`](../lib/systems/registry.ts).
The navigation, the `/systems` map, the per-page banner and `/guide` all read
from it, so a system cannot be added to the product and forgotten in the
documentation. `__tests__/systems-registry.test.ts` enforces that every page it
names exists on disk.

---

## 3. What each system owns

Reproduce with `git diff --name-only upstream/main...origin/main`.

### Instagram DM — came with the fork

- **Models**: `InstagramAccount`, `Automation`, `DmLog`, `WebhookEvent`,
  `TrackedLink`, `LinkClick`, `FollowerSnapshot`
- **Routes**: `/api/webhook`, `/api/instagram/*`, `/api/automations`,
  `/api/dashboard/stats`, `/api/logs`, `/r/[slug]`
- **Code**: `lib/meta`, `lib/queue`, `lib/tracking`, `worker/dm-worker.ts`

### WhatsApp — fused in

- **Models**: `WhatsAppLead`, `WhatsAppMessage`
- **Routes**: `/api/whatsapp/sessions`, `/api/whatsapp/sessions/[id]/qr`,
  `/api/whatsapp/sessions/[id]/start`, `/api/whatsapp/webhook`,
  `/api/whatsapp/leads`, `/api/whatsapp/funnel`
- **Code**: `lib/whatsapp` (5 files), `components/whatsapp-numbers.tsx`,
  `components/whatsapp-link-picker.tsx`

Sessions themselves are **not** in Postgres — they live in the OpenWA service.
That is why the status probe for WhatsApp reports what the database knows and
sends you to `/whatsapp` for the question only OpenWA can answer. Asking OpenWA
from a status endpoint would mean a status page that can hang.

### Harvey — fused in

- **Models**: `HarveyAgent`, `HarveyCompany`, `HarveyProspect`, `HarveyEmail`,
  `HarveyCommand`, `OutreachEvent`
- **Routes**: `/api/harvey/v1/sync`, `/api/harvey/v1/links`,
  `/api/outreach/agents`, `/api/outreach/outbox`, `/api/outreach/brand`
- **Code**: `lib/harvey` (3 files), `lib/outreach`

The agent side lives in a separate repository (`~/Projects/harvey`), in
`harvey/integrations/openreply.py`. Traffic is **outbound only**: Harvey pushes
and polls, nothing listens on the Mac.

### Resource hub — fused in

- **Models**: `Resource`, `ResourceLead`, plus `Workspace.publicSlug`
- **Routes**: `/api/outreach/resources`, `/api/resources/[brand]/[slug]/claim`,
  and the public `/resources/[brand]` and `/resources/[brand]/[slug]`
- **Code**: `lib/resources`, `lib/email`, `components/resource-gate-form.tsx`

### Platform — came with the fork, extended here

- **Models**: `Workspace`, `WorkspaceMember`, `WorkspaceInvitation`, `User`,
  `OperationalEvent`
- **Routes**: `/api/systems/status`, `/api/admin/diagnostics`,
  `/api/workspace/*`, `/api/health`, `/api/auth/*`
- **Code**: `lib/systems`, `lib/ops`, `lib/db`, `lib/auth.ts`

---

## 4. The seams — where fused code touches forked code

This is the part that matters for pulling upstream changes later. Of the files
that already existed upstream, the fusion touched **19**, and outside the
Prisma schema every one of them is a small, local edit:

| Upstream file | Lines added | What the fusion needed |
| --- | --- | --- |
| `prisma/schema.prisma` | 649 | Every new model, `TrackedLinkSource`, `Workspace.publicSlug`, `OperationalEventSource.HARVEY` |
| `__tests__/redirect.test.ts` | 131 | Cover a tracked link that belongs to something other than Instagram |
| `app/api/admin/diagnostics/route.ts` | 39 | Surface Harvey and WhatsApp events on the diagnostics page |
| `lib/polling/comment-reconciler.ts` | 39 | Relay reconciled comments to the external agent |
| `app/r/[slug]/route.ts` | 37 | Record an `OutreachEvent` when a cold-email link is clicked |
| `app/api/instagram/overview/route.ts` | 29 | Name the account whose Instagram session died |
| `.env.example` | 24 | New keys, names only |
| `app/(dashboard)/diagnostics/page.tsx` | 20 | Render the new event sources |
| `app/api/dashboard/stats/route.ts` | 15 | Exclude outbound clicks from Instagram numbers |
| `app/api/webhook/route.ts` | 15 | Hand verified webhooks to the relay |
| `components/campaign-builder.tsx` | 5 | Offer the WhatsApp link picker |
| `worker/dm-worker.ts` | 5 | Run the relay worker alongside the DM worker |
| `app/(dashboard)/settings/page.tsx` | 3 | Mount the WhatsApp numbers panel |
| `app/api/automations/route.ts` | 3 | Skip clicks with no automation behind them |
| `vercel.json` | 1 | Pin the framework preset |

Plus, in this change: `components/sidebar.tsx` and `components/top-bar.tsx`
were rewritten to read from the systems registry rather than hard-coded lists.

### The one seam worth remembering

`app/api/dashboard/stats/route.ts` and `/api/whatsapp/funnel` both count
`LinkClick` rows. Harvey's cold-email links are `TrackedLink`s with **no**
automation behind them, so without an explicit filter they inflate the
Instagram dashboard's click count and CTR whenever no specific account is
selected. Both call sites carry `automationId: { not: null }` for that reason.
If you ever add a third source of tracked links, that is the filter to check.

---

## 5. Why one database

All five systems share one Postgres database. That is a decision, not an
accident, and it is the one thing that makes this fusion worth more than
running four separate tools:

- A cold email click (`LinkClick` via `/r/[slug]`) and the WhatsApp chat it
  caused (`WhatsAppLead.refSlug`) are joined by one slug.
- A resource claim (`ResourceLead`) becomes a Harvey prospect only because both
  live in the same place and consent can be checked in the same query.
- Engagement in any channel becomes an `OutreachEvent` the agent reads back.

Split the database and all three of those become integrations to build and
maintain. The cost of sharing is honest and worth stating: **a bad migration is
a bad migration for everything**, and all five systems go down together.

---

## 6. Pulling upstream changes

```bash
git fetch upstream
git merge upstream/main
```

Expect conflicts only in the files in the seams table. The schema will always
conflict if upstream touches it, because our additions sit in the same file;
resolve by keeping both sets of models and re-running:

```bash
npx prisma migrate dev --name merge_upstream
```

Run `npm test`, `npm run lint` and `npx tsc --noEmit` afterwards. The registry
test is the one that catches a merge having quietly dropped a page.
