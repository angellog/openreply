# Harvey ⨯ OpenReply fusion plan

Status: implementation plan, decided. Implementer: follow literally; where the body says "decide", it already has. Uncertainties live only in §9.

Owner: Angelo (`angellog`), Kampala. Businesses: FeetBit (sneaker retail; B2B wholesale is the untapped side) and Vantik / Equator Advisory (pure B2B advisory, Cal.com, deliberately no WhatsApp).

What exists today and is reused unchanged: OpenReply's inbound Instagram comment → DM → `/r/<slug>` tracked link → `wa.me` with `(ref: <slug>)` → OpenWA webhook → `lib/whatsapp/inbound.ts` → `WhatsAppLead` + one auto-reply. That is the attribution machinery this plan plugs cold email into.

---

## 1. Decision

**Chosen: Harvey runs unchanged in spirit on the owner's Mac (one process per brand), and OpenReply becomes the cloud control plane and system of record for decisions and attribution.** Harvey gains one opt-in integration module that, every 60 s, (a) signs and POSTs a heartbeat plus its prospects / outbox / conversations to `/api/harvey/v1/*`, (b) asks OpenReply to mint tracked links for emails about to go out and rewrites the email bodies to use them, (c) pulls the owner's phone decisions (approve / reject / edit / pause / hand-off) as idempotent commands and acks them, and (d) pulls OpenReply's attribution events (link clicked, WhatsApp chat started, WhatsApp replied) and turns them into Harvey observations, stop-on-reply and conversations. No inbound port, no tunnel, no ngrok. The Claude Code CLI stays logged in on the Mac, exactly where Anthropic's subscription expects it. OpenReply never calls a model. Everything Harvey knows is mirrored into Postgres, so the Mac dying loses operational state but not the record.

Runners-up:
- **Port Harvey to TypeScript inside OpenReply** — 16.8 k LOC plus a brain that is a logged-in CLI subprocess; the port still cannot run on Vercel, so you would end with a TypeScript Harvey on the Mac anyway, having lost upstream updates and weeks. Zero gain, all cost.
- **Harvey as a Railway service** — the Claude CLI's credentials on macOS live in the Keychain (`Claude Code-credentials`, see `harvey/integrations/quota.py`), not a mountable file; Codex logins need interactive renewal every ~8 days; and running a consumer Claude/ChatGPT subscription as a headless cloud worker is at best against the spirit of those plans (Harvey's README: "runs locally with your own login"). Keep as a future option only if an API-key brain is added upstream.
- **CSV export/import** — no approve-from-phone, no attribution, no stop-on-reply across channels. It is the baseline this plan beats.

Why the hard constraint resolves the way it does (`TrackedLink.automationId` NOT NULL etc.): see §3.1 — option (b)+(a): a first-class `TrackedLinkSource` discriminator with nullable Instagram columns. A synthetic placeholder Automation is rejected because `Automation.instagramAccountId` is NOT NULL, so FeetBit wholesale emails would be attributed to an Instagram account they have nothing to do with, the placeholder would appear in `/campaigns`, in `totalAutomations`, and the comment reconciler would sweep it every 5 minutes.

---

## 2. Architecture

```mermaid
flowchart LR
  subgraph PHONE["Owner's phone (browser / PWA)"]
    UI["OpenReply dashboard<br/>/outreach · /whatsapp · /settings · /diagnostics"]
  end

  subgraph VERCEL["Vercel — openreply web (Next.js 16)"]
    API_UI["Session-auth API<br/>/api/outreach/*"]
    API_H["HMAC-auth API<br/>/api/harvey/v1/*"]
    R["/r/[slug] redirect"]
    WAWH["/api/whatsapp/webhook"]
  end

  subgraph RAILWAY["Railway project openreply"]
    PG[("Postgres<br/>HarveyAgent · HarveyProspect · HarveyOutboxItem<br/>HarveyConversation · HarveyCommand · OutreachEvent<br/>TrackedLink(source) · WhatsAppLead(harveyProspectId)")]
    REDIS[("Redis / BullMQ")]
    WORKER["worker/dm-worker.ts<br/>+ lib/harvey/agent-watch.ts (10 min)"]
    OPENWA["OpenWA container<br/>(unofficial WhatsApp client, spare number)"]
  end

  subgraph MAC["Owner's Mac (always-on, launchd)"]
    H1["harvey run — instance feetbit<br/>~/Projects/harvey-feetbit<br/>SQLite data/harvey.db"]
    H2["harvey run — instance vantik<br/>~/Projects/harvey-vantik"]
    BR["harvey/integrations/openreply.py<br/>bridge loop every 60 s"]
    CLI["claude -p --tools '' (Claude Max subscription)"]
    H1 --> BR
    H2 --> BR
    H1 --> CLI
    H2 --> CLI
  end

  MAIL["Dedicated sending mailboxes<br/>Gmail API / SMTP+IMAP<br/>(one per brand, owner-provisioned)"]
  PROSPECT["Prospect"]
  CAL["Cal.com (Vantik)"]
  WA["WhatsApp (FeetBit)"]

  UI -->|HTTPS session cookie| API_UI
  API_UI --> PG
  API_H --> PG
  R --> PG
  WAWH --> PG
  WORKER --> PG
  WORKER --> REDIS
  OPENWA -->|X-OpenWA-Signature| WAWH
  WAWH -->|one auto-reply| OPENWA

  BR -->|"POST signed JSON (outbound only)<br/>heartbeat · sync · links.mint<br/>commands.pull/ack · events.pull"| API_H
  H1 -->|send / read replies| MAIL
  MAIL -->|cold email with /r/slug link| PROSPECT
  PROSPECT -->|tap| R
  R -->|302 wa.me?text=...(ref: slug)| WA
  R -->|302| CAL
  WA -->|first message carries ref| OPENWA
  PROSPECT -->|email reply| MAIL

  classDef trust fill:#fff,stroke:#333,stroke-dasharray: 4 2;
  class PHONE,VERCEL,RAILWAY,MAC trust;
```

Trust boundaries (dashed): phone ↔ Vercel is NextAuth session; Vercel ↔ Mac is per-agent HMAC with a 300 s timestamp window (the Mac holds the secret; Vercel holds it encrypted with `ENCRYPTION_KEY`); OpenWA ↔ Vercel is the existing `OPENWA_WEBHOOK_SECRET`; Mac ↔ Anthropic is the owner's own CLI login; Mac ↔ mailbox is the owner's own OAuth/app password. Nothing on the Mac listens.

Processes and where they run: `next` on Vercel; `worker/dm-worker.ts` on Railway (gains the agent watch); OpenWA on Railway (unchanged); two `harvey run` processes on the Mac under launchd, each with its own checkout, `.env`, `harvey.local.yaml`, SQLite; two local Harvey dashboards (5555 / 5556) for debugging only — the phone UI is OpenReply.

---

## 3. Data model changes (Prisma, `prisma/schema.prisma`)

### 3.1 The nullability decision

`TrackedLink.automationId`, `LinkClick.automationId`, `LinkClick.instagramAccountId` become nullable, and `TrackedLink` gains a `source TrackedLinkSource @default(AUTOMATION)` discriminator plus Harvey foreign keys. Rationale: nullable alone leaves "why is this null" implicit; the discriminator makes every query explicit (`source: "HARVEY"`), lets the Instagram dashboard stay Instagram-only by filtering `automationId: { not: null }`, and keeps the reports (`lib/reports/data.ts`, per-automation) untouched because Harvey links never belong to an automation. Existing rows backfill to `AUTOMATION` by default. This is backward compatible with the currently deployed worker (widening only), so web can deploy before worker.

Ripple effects, each handled in Phase 2:
- `app/r/[slug]/route.ts`: `instagramAccountId: trackedLink.automation?.instagramAccountId ?? null`; when `source === "HARVEY"` also create an `OutreachEvent LINK_CLICKED`.
- `app/api/whatsapp/funnel/route.ts`: add `automationId: { not: null }` to the `linkClick.groupBy` where-clause (leads already filter it).
- `app/api/dashboard/stats/route.ts`: add `automationId: { not: null }` to both `linkClick.count` calls.
- `lib/whatsapp/inbound.ts`: Harvey-sourced ref → attribute lead to `harveyAgentId`/`harveyProspectId`, auto-reply from `HarveyAgent.whatsappGreeting`.
- `lib/reports/data.ts`: no change (per-automation).

### 3.2 Enums

```prisma
enum TrackedLinkSource { AUTOMATION HARVEY }
enum HarveyAgentStatus { ACTIVE REVOKED }
enum HarveyOutboxStatus { PENDING_REVIEW APPROVED SENT FAILED REJECTED CANCELLED }
enum HarveyOutboxKind { SEQUENCE REPLY }
enum HarveyCommandType { APPROVE_OUTBOX REJECT_OUTBOX EDIT_OUTBOX APPROVE_ALL PAUSE_SENDING RESUME_SENDING HANDOFF_LEAD }
enum HarveyCommandStatus { PENDING DELIVERED ACKED FAILED EXPIRED }
enum OutreachEventType { EMAIL_SENT EMAIL_REPLIED LINK_CLICKED WHATSAPP_STARTED WHATSAPP_MESSAGE_IN LEAD_HANDED_OFF SENDING_PAUSED SENDING_RESUMED }
```
`OperationalEventSource` gains `HARVEY`.

Harvey's prospect/conversation status vocabularies stay `String` in the mirrors (they are Harvey-owned and upstream may add values; an enum would force a migration for every upstream change). Outbox status and kind are enums because the bridge maps them explicitly and the UI switches on them.

### 3.3 New models

```prisma
/// One Harvey instance (one brand, one checkout on the owner's machine).
model HarveyAgent {
  id              String            @id @default(cuid())
  workspaceId     String
  name            String            // e.g. "feetbit-wholesale", "vantik"
  status          HarveyAgentStatus @default(ACTIVE)
  /// HMAC secret, AES-256-GCM via lib/meta/oauth encryptToken(). Shown once at creation.
  secretEncrypted String
  secretPrefix    String            // first 6 chars, display only
  /// Destination for links minted with destination "whatsapp".
  whatsappSessionId String?
  whatsappPhone     String?
  whatsappMessage   String?         // prefilled text, default "Hi! I got your email"
  /// One-time auto-reply for chats that arrive via this agent's links. Null = no reply.
  whatsappGreeting  String?
  /// Destination for links minted with destination "default" (Vantik: Cal.com).
  defaultDestinationUrl String?
  lastSeenAt      DateTime?
  lastHeartbeat   Json?
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  workspace     Workspace            @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  prospects     HarveyProspect[]
  outboxItems   HarveyOutboxItem[]
  conversations HarveyConversation[]
  commands      HarveyCommand[]
  trackedLinks  TrackedLink[]
  events        OutreachEvent[]
  whatsappLeads WhatsAppLead[]

  @@unique([workspaceId, name])
  @@index([workspaceId])
}

/// Mirror of a Harvey prospect (+ denormalised company). Harvey is the writer.
model HarveyProspect {
  id                   String   @id @default(cuid())
  workspaceId          String
  agentId              String
  harveyId             String   // prospects.id in Harvey's SQLite
  companyHarveyId      String?
  companyName          String?
  companyDomain        String?
  companyWebsite       String?
  firstName            String
  lastName             String
  email                String?
  emailStatus          String?  // verified | risky | guess | invalid
  title                String?
  phone                String?
  status               String   // Harvey vocabulary: new, queued, contacted, replied, opted_out, lost, meeting, closed
  score                Int      @default(0)
  personalizationNotes String?
  source               String?
  /// Set when this prospect was created by a HANDOFF_LEAD from a WhatsApp chat.
  whatsAppLeadId       String?  @unique
  harveyUpdatedAt      DateTime
  lastSyncedAt         DateTime
  createdAt            DateTime @default(now())
  updatedAt            DateTime @updatedAt

  workspace     Workspace            @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  agent         HarveyAgent          @relation(fields: [agentId], references: [id], onDelete: Cascade)
  whatsAppLead  WhatsAppLead?        @relation("HandedOffLead", fields: [whatsAppLeadId], references: [id], onDelete: SetNull)
  outboxItems   HarveyOutboxItem[]
  conversations HarveyConversation[]
  trackedLinks  TrackedLink[]
  events        OutreachEvent[]
  attributedLeads WhatsAppLead[]     @relation("AttributedLead")

  @@unique([agentId, harveyId])
  @@index([workspaceId, status])
  @@index([workspaceId, email])
}

model HarveyOutboxItem {
  id                   String             @id @default(cuid())
  workspaceId          String
  agentId              String
  harveyId             String             // outbox.id in Harvey
  prospectId           String
  campaignHarveyId     String?
  conversationHarveyId String?
  step                 Int
  kind                 HarveyOutboxKind
  toEmail              String
  subject              String
  body                 String
  /// sha256 hex of body (utf-8). Approvals carry it so a body edited after viewing is not approved blind.
  bodyHash             String
  status               HarveyOutboxStatus
  sendAt               DateTime?
  sentAt               DateTime?
  provider             String?
  messageId            String?
  threadRef            String?
  error                String?
  trackedLinkId        String?            @unique
  harveyUpdatedAt      DateTime
  lastSyncedAt         DateTime
  createdAt            DateTime @default(now())
  updatedAt            DateTime @updatedAt

  workspace   Workspace       @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  agent       HarveyAgent     @relation(fields: [agentId], references: [id], onDelete: Cascade)
  prospect    HarveyProspect  @relation(fields: [prospectId], references: [id], onDelete: Cascade)
  trackedLink TrackedLink?    @relation(fields: [trackedLinkId], references: [id], onDelete: SetNull)
  commands    HarveyCommand[]
  events      OutreachEvent[]

  @@unique([agentId, harveyId])
  @@index([workspaceId, status, sendAt])
  @@index([agentId, status])
}

model HarveyConversation {
  id              String   @id @default(cuid())
  workspaceId     String
  agentId         String
  harveyId        String
  prospectId      String
  channel         String   // email | whatsapp
  intent          String?
  stage           String
  status          String
  /// [{ sender: "harvey"|"prospect", content, timestamp }]
  thread          Json
  harveyUpdatedAt DateTime
  lastSyncedAt    DateTime
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  workspace Workspace      @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  agent     HarveyAgent    @relation(fields: [agentId], references: [id], onDelete: Cascade)
  prospect  HarveyProspect @relation(fields: [prospectId], references: [id], onDelete: Cascade)

  @@unique([agentId, harveyId])
  @@index([workspaceId, status])
}

/// A decision made in OpenReply, waiting for Harvey to pull and apply it.
model HarveyCommand {
  id              String              @id @default(cuid())
  workspaceId     String
  agentId         String
  type            HarveyCommandType
  payload         Json
  idempotencyKey  String              @unique
  status          HarveyCommandStatus @default(PENDING)
  outboxItemId    String?
  whatsAppLeadId  String?
  createdByUserId String?
  attempts        Int                 @default(0)
  createdAt       DateTime @default(now())
  deliveredAt     DateTime?
  ackedAt         DateTime?
  ackResult       Json?
  expiresAt       DateTime?

  workspace  Workspace         @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  agent      HarveyAgent       @relation(fields: [agentId], references: [id], onDelete: Cascade)
  outboxItem HarveyOutboxItem? @relation(fields: [outboxItemId], references: [id], onDelete: SetNull)

  @@index([agentId, status, createdAt])
  @@index([outboxItemId])
  @@index([whatsAppLeadId])
}

/// Append-only attribution log. `seq` is the pull cursor for Harvey.
model OutreachEvent {
  id             String            @id @default(cuid())
  seq            Int               @unique @default(autoincrement())
  workspaceId    String
  agentId        String?
  prospectId     String?
  outboxItemId   String?
  trackedLinkId  String?
  whatsAppLeadId String?
  type           OutreachEventType
  occurredAt     DateTime          @default(now())
  payload        Json?

  workspace  Workspace         @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  agent      HarveyAgent?      @relation(fields: [agentId], references: [id], onDelete: SetNull)
  prospect   HarveyProspect?   @relation(fields: [prospectId], references: [id], onDelete: SetNull)
  outboxItem HarveyOutboxItem? @relation(fields: [outboxItemId], references: [id], onDelete: SetNull)

  @@index([agentId, seq])
  @@index([workspaceId, occurredAt])
  @@index([prospectId, occurredAt])
}
```

### 3.4 Changes to existing models

```prisma
model TrackedLink {
  automationId     String?                      // was NOT NULL
  source           TrackedLinkSource @default(AUTOMATION)
  harveyAgentId    String?
  harveyProspectId String?
  harveyOutboxRef  String?                      // Harvey outbox.id the link was minted for
  automation       Automation?     @relation(fields: [automationId], references: [id], onDelete: Cascade)
  harveyAgent      HarveyAgent?    @relation(fields: [harveyAgentId], references: [id], onDelete: Cascade)
  harveyProspect   HarveyProspect? @relation(fields: [harveyProspectId], references: [id], onDelete: Cascade)
  harveyOutboxItem HarveyOutboxItem?
  @@unique([harveyAgentId, harveyOutboxRef])
  @@index([source])
}

model LinkClick {
  automationId       String?   // was NOT NULL
  instagramAccountId String?   // was NOT NULL
  automation       Automation?       @relation(fields: [automationId], references: [id], onDelete: Cascade)
  instagramAccount InstagramAccount? @relation(fields: [instagramAccountId], references: [id], onDelete: Cascade)
}

model WhatsAppLead {
  harveyAgentId    String?
  harveyProspectId String?
  harveyAgent      HarveyAgent?    @relation(fields: [harveyAgentId], references: [id], onDelete: SetNull)
  harveyProspect   HarveyProspect? @relation("AttributedLead", fields: [harveyProspectId], references: [id], onDelete: SetNull)
  handedOffProspect HarveyProspect? @relation("HandedOffLead")
  @@index([harveyProspectId])
}

model Workspace {
  harveyAgents        HarveyAgent[]
  harveyProspects     HarveyProspect[]
  harveyOutboxItems   HarveyOutboxItem[]
  harveyConversations HarveyConversation[]
  harveyCommands      HarveyCommand[]
  outreachEvents      OutreachEvent[]
}
```

### 3.5 Migration strategy (Prisma 7, offline SQL)

Two migrations, one per phase, so Phase 1 ships without touching Instagram tables:

1. `prisma/migrations/20261020120000_harvey_control_plane/migration.sql` — enums `HarveyAgentStatus`, `HarveyOutboxStatus`, `HarveyOutboxKind`, `HarveyCommandType`, `HarveyCommandStatus`; `ALTER TYPE "OperationalEventSource" ADD VALUE 'HARVEY'`; tables `HarveyAgent`, `HarveyProspect`, `HarveyOutboxItem`, `HarveyConversation`, `HarveyCommand`. (`HarveyProspect.whatsAppLeadId` and `HarveyCommand.whatsAppLeadId` are plain nullable columns in this migration; the FK relation is added in migration 2 — or include it here since `WhatsAppLead` already exists; implementer's choice, the schema above is the end state.)
2. `prisma/migrations/20261027120000_harvey_attribution/migration.sql` — `TrackedLinkSource`, `OutreachEventType`; `ALTER TABLE "TrackedLink" ALTER COLUMN "automationId" DROP NOT NULL` plus new columns and unique index; `LinkClick` DROP NOT NULL ×2; `WhatsAppLead` new columns; `OutreachEvent` table with `seq SERIAL`.

Generate each with the previous committed schema as the baseline (no shadow DB needed):
```
git show HEAD:prisma/schema.prisma > <scratch>/prev.prisma
npx prisma migrate diff --from-schema <scratch>/prev.prisma --to-schema prisma/schema.prisma --script > prisma/migrations/<name>/migration.sql
```
Review the SQL by hand (check the `DROP NOT NULL`s and that no `DROP COLUMN` appears). `npm run vercel-build` runs `prisma migrate deploy` on Vercel; deploy web first, then the Railway worker (`npm run db:generate` at build). Both migrations are purely additive/widening, so the old worker keeps running during the window.

---

## 4. Wire protocol: `/api/harvey/v1/*`

### 4.1 Transport and auth

Every call is `POST` with a JSON body (there are no GETs; pulls are POSTs with a body so they are signed the same way). Harvey is always the client.

Headers (adopted from the existing `harvey/integrations/openreply.py`):
- `Content-Type: application/json`
- `X-Harvey-Node: <HarveyAgent.id>` — which agent; the server decrypts that agent's secret.
- `X-Harvey-Timestamp: <unix seconds>` — signed material.
- `X-Harvey-Signature: sha256=<hex HMAC-SHA256(secret, "<timestamp>.<raw body>")>`.

Body canonicalisation: Harvey sends `json.dumps(payload, separators=(",", ":"), sort_keys=True)` byte-for-byte. The server verifies over the raw request text (`await request.text()`), never over re-serialised JSON.

Server verification (`lib/harvey/signature.ts`, modelled on `lib/whatsapp/signature.ts`): reject if agent unknown or `status !== ACTIVE`; reject if `|now - timestamp| > 300`; compute expected, compare with `timingSafeEqual` after a length check; then `JSON.parse` the body and require `body.kind === <route's kind>` — the path is not inside the signed string, so the `kind` field is what stops a captured `commands.ack` body being replayed to `sync`. Replay inside the 300 s window is harmless because every mutation is idempotent (below). Shared helper: `lib/harvey/auth.ts::authenticateHarveyRequest(request: NextRequest, kind: HarveyKind): Promise<{ agent, payload } | NextResponse>`; routes return the `NextResponse` when it is one. Signature failures write an `OperationalEvent` (`source: HARVEY`, `WARNING`, deduped hourly per agent) with `hadSignatureHeader`, `skewSeconds`, never the body.

Golden vector (already in `tests/test_openreply_bridge.py`; must also be asserted in `__tests__/harvey-signature.test.ts`):
```
body      {"alpha":2,"kind":"sync","prospects":[{"email":"a@b.co","id":"p1"}],"zeta":1}
timestamp 1760000000
secret    shared-secret
signature sha256=1d44b02d29d2b1f440b6561f23669c6ae0eebf75331336bb665a348713786406
```

Response envelope matches the repo: `{ "success": true, "data": {...} }` or `{ "success": false, "error": "<message>", "issues"?: [...] }`.

Error codes: `401` invalid/expired signature or revoked agent; `400` zod validation failure (`issues` is zod's flattened output); `409` `kind` mismatch; `413` any array longer than 200; `500` unexpected (bridge retries next loop). Request bodies are validated with zod schemas in `lib/harvey/schemas.ts`.

Limits: 200 items per array, 1 MB body. Timestamps in payloads are ISO-8601 strings (Harvey stores naive UTC; the bridge appends `Z`).

### 4.2 `POST /api/harvey/v1/heartbeat` — kind `heartbeat`

Request:
```json
{ "kind": "heartbeat",
  "version": "0.3.0+openreply.1", "provider": "claude", "model": "",
  "hostname": "angelos-mac", "startedAt": "2026-10-20T07:00:00Z",
  "pausedReason": "", "sendingPaused": "",
  "quota": { "utilizationPct": 42.0, "resetsAt": "2026-10-20T13:00:00Z" },
  "sendsToday": 6, "maxDailySends": 15, "requireApproval": true, "linkedinEnabled": false,
  "counts": { "pendingReview": 4, "approved": 1, "sentTotal": 38,
              "prospects": { "new": 12, "queued": 3, "contacted": 30, "replied": 4 } },
  "cursors": { "events": 118 } }
```
Response: `{ "success": true, "data": { "serverTime": "...", "commandsPending": 2 } }`.
Effect: `HarveyAgent.lastSeenAt = now`, `lastHeartbeat = body`. If `requireApproval` is false, the server records an `OperationalEvent` ERROR `Harvey agent "<name>" is in autopilot (require_approval: false); approve-from-phone is bypassed` (hourly dedupe). If `linkedinEnabled` is true, WARNING `LinkedIn automation is enabled on Harvey agent "<name>"` (hourly dedupe).

### 4.3 `POST /api/harvey/v1/sync` — kind `sync`

Request (any array may be empty; order of application is prospects → outbox → conversations):
```json
{ "kind": "sync",
  "prospects": [{ "id": "p_...", "companyId": "c_...", "company": { "name": "Kampala Kicks", "domain": "kampalakicks.ug", "website": "https://..." },
                  "firstName": "Jane", "lastName": "Okello", "email": "jane@kampalakicks.ug", "emailStatus": "verified",
                  "title": "Owner", "phone": "", "status": "queued", "score": 82, "personalizationNotes": "...", "source": "osm", "updatedAt": "..." }],
  "outbox": [{ "id": "o_...", "campaignId": "camp_...", "prospectId": "p_...", "conversationId": "", "step": 1, "kind": "sequence",
               "toEmail": "jane@kampalakicks.ug", "subject": "...", "body": "...", "status": "pending_review",
               "sendAt": "...", "sentAt": null, "provider": "gmail", "messageId": "", "threadRef": "", "error": "", "updatedAt": "..." }],
  "conversations": [{ "id": "cv_...", "prospectId": "p_...", "channel": "email", "intent": "interested", "stage": "engaged", "status": "open",
                      "thread": [{ "sender": "prospect", "content": "...", "timestamp": "..." }], "updatedAt": "..." }] }
```
Response:
```json
{ "success": true, "data": { "accepted": { "prospects": 12, "outbox": 9, "conversations": 1 },
  "stale": [{ "type": "outbox", "id": "o_..." }],
  "rejected": [{ "type": "outbox", "id": "o_...", "reason": "unknown prospect p_..." }] } }
```
Semantics: upsert by `(agentId, harveyId)`; apply only if incoming `updatedAt >= stored harveyUpdatedAt` (else report in `stale`); `lastSyncedAt = now`; `bodyHash = sha256(body)`. Server-side derived events on transitions: outbox `status` entering `SENT` → `OutreachEvent EMAIL_SENT {step, kind, toEmail}`; a conversation whose thread gains a `sender: "prospect"` message → `EMAIL_REPLIED {intent, stage}` (compare thread lengths of prospect messages). An outbox item referencing an unknown prospect is rejected (the bridge pushes prospects first and retries next loop). Mapping: Harvey `kind` `sequence|reply` → `SEQUENCE|REPLY`; status lowercase → enum. Items in `rejected` are retried by the bridge indefinitely (cursor does not advance past them).

### 4.4 `POST /api/harvey/v1/links` — kind `links.mint`

Request:
```json
{ "kind": "links.mint",
  "items": [{ "outboxId": "o_...", "prospectId": "p_...", "step": 2,
              "destination": "whatsapp" | "default" | { "url": "https://cal.com/vantik/15min" } }] }
```
Response: `{ "success": true, "data": { "links": [{ "outboxId": "o_...", "slug": "aB3_x9Zk2q", "trackedUrl": "https://openreply-azure-six.vercel.app/r/aB3_x9Zk2q" }], "rejected": [...] } }`.
Semantics: idempotent on `(harveyAgentId, harveyOutboxRef = outboxId)` — a repeated call returns the existing slug. `destination: "whatsapp"` requires `agent.whatsappPhone`; destination URL is `buildWhatsAppHandoffTemplate({ phone: agent.whatsappPhone, message: agent.whatsappMessage ?? "Hi! I got your email" })` from `lib/whatsapp/ref.ts` (the `{ref}` placeholder is resolved at click time by the existing route). `"default"` uses `agent.defaultDestinationUrl`. Creates `TrackedLink { workspaceId, automationId: null, source: HARVEY, slug: generateTrackedLinkSlug(), destinationUrl, harveyAgentId, harveyProspectId (resolved from (agentId, prospectId); reject if unknown), harveyOutboxRef, label: "harvey step <n>" }`. `trackedUrl = buildTrackedUrl(slug, getBaseUrl())`. Links are minted before the outbox item is pushed; when the item later arrives in `sync`, the server sets `HarveyOutboxItem.trackedLinkId` by looking up `(agentId, harveyOutboxRef)`.

### 4.5 `POST /api/harvey/v1/commands/pull` — kind `commands.pull`

Request: `{ "kind": "commands.pull", "limit": 50 }`.
Response: `{ "success": true, "data": { "commands": [{ "id": "cmd_...", "type": "APPROVE_OUTBOX", "payload": {...}, "idempotencyKey": "...", "createdAt": "..." }] } }`.
Semantics (single transaction): first lazily expire `status IN (PENDING, DELIVERED) AND expiresAt < now` → `EXPIRED`; then select for this agent `status = PENDING OR (status = DELIVERED AND deliveredAt < now - 10 min)` ordered by `createdAt`, limit; set `DELIVERED`, `deliveredAt = now`, `attempts += 1`; any with `attempts > 20` → `FAILED` (`ackResult: { error: "undelivered after 20 attempts" }`) and excluded. At-least-once delivery; Harvey de-duplicates on `idempotencyKey` using its `settings` table (`openreply.cmd.<idempotencyKey>` = result JSON) and re-acks without re-applying.

Command payloads (all carry `outboxId` = Harvey's outbox id where relevant):
- `APPROVE_OUTBOX { "outboxId", "expectedBodyHash" }` — Harvey: if `sha256(current body) != expectedBodyHash` → `failed: body_changed`; else `approve_outbox(outboxId)`; result `{ "approved": 1 }` or `noop` with `{ "status": "<current>" }` when no longer `pending_review` (e.g. cancelled because the prospect replied).
- `REJECT_OUTBOX { "outboxId", "reason" }` — `update_outbox_item(status="rejected", error=reason[:300])` if status in (`pending_review`, `approved`); else `noop`.
- `EDIT_OUTBOX { "outboxId", "subject", "body" }` — only if `pending_review`; `update_outbox_item(subject=, body=)`; result `{ "bodyHash": "<new>" }`. The UI sends EDIT then APPROVE with the new hash. The deterministic gate still runs at send time; a gate failure surfaces as `FAILED` with `error: "gate: ..."` on the next sync.
- `APPROVE_ALL {}` — `approve_outbox()`; result `{ "approved": n }`. UI requires a typed confirmation; it exists for the "I read them all on the Mac" case only.
- `PAUSE_SENDING { "reason" }` — `set_setting("sending_paused", f"paused from OpenReply: {reason}")`. `RESUME_SENDING {}` — `set_setting("sending_paused", "")`. Server also writes `OutreachEvent SENDING_PAUSED/RESUMED` on ack.
- `HANDOFF_LEAD` — see §4.8.

Idempotency keys (server-generated): `approve:<outboxItemId>:<bodyHash>`, `reject:<outboxItemId>`, `edit:<outboxItemId>:<sha256(subject+"\n"+body)>`, `approve_all:<agentId>:<yyyy-mm-ddThh>`, `pause:<agentId>:<createdAt ms>`, `resume:<agentId>:<createdAt ms>`, `handoff:<whatsAppLeadId>:<agentId>`. A duplicate key from the UI returns the existing command (HTTP 200), so double-taps are safe.

Expiry defaults (`expiresAt`): APPROVE/EDIT/REJECT 7 days; APPROVE_ALL 24 h; PAUSE/RESUME never; HANDOFF 30 days.

### 4.6 `POST /api/harvey/v1/commands/ack` — kind `commands.ack`

Request: `{ "kind": "commands.ack", "results": [{ "id": "cmd_...", "status": "ok" | "noop" | "failed", "result": {...}, "error": "..." }] }`.
Response: `{ "success": true, "data": { "acked": n } }`.
Semantics: `ok`/`noop` → `ACKED`; `failed` → `FAILED`; store `ackResult`, `ackedAt`; acking an already-acked command is a no-op. On `HANDOFF_LEAD` ok: create/upsert the `HarveyProspect` mirror from `result.prospect` (same shape as a sync prospect) with `whatsAppLeadId`, set `WhatsAppLead.harveyProspectId/harveyAgentId`, write `OutreachEvent LEAD_HANDED_OFF`. On PAUSE/RESUME ok: write the corresponding event.

### 4.7 `POST /api/harvey/v1/events/pull` — kind `events.pull`

Request: `{ "kind": "events.pull", "after": 118, "limit": 200 }`.
Response: `{ "success": true, "data": { "events": [{ "seq": 119, "type": "LINK_CLICKED", "occurredAt": "...", "prospectId": "p_...", "outboxId": "o_...", "payload": { "slug": "...", "step": 2 } }], "nextCursor": 131 } }`.
Semantics: read-only; returns rows with `agentId = me AND seq > after AND type IN (LINK_CLICKED, WHATSAPP_STARTED, WHATSAPP_MESSAGE_IN)` ordered by `seq`; `prospectId`/`outboxId` are translated back to Harvey ids via the mirrors. `EMAIL_SENT`/`EMAIL_REPLIED`/`LEAD_HANDED_OFF` are never returned (Harvey already knows). Payloads: `LINK_CLICKED { slug, step, userAgent }`; `WHATSAPP_STARTED { whatsAppLeadId, phone, displayName, body }`; `WHATSAPP_MESSAGE_IN { whatsAppLeadId, body }`.

### 4.8 `HANDOFF_LEAD` command payload and result

Payload (built by `POST /api/outreach/handoff`, §6):
```json
{ "whatsAppLeadId": "lead_...", "origin": "whatsapp",
  "contact": { "firstName": "Jane", "lastName": "Okello", "title": "Owner", "email": "jane@kampalakicks.ug", "phone": "256700123456" },
  "company": { "name": "Kampala Kicks", "website": "https://kampalakicks.ug", "location": "Kampala" },
  "igUsername": "kampalakicks", "notes": "Asked about wholesale prices for 20 pairs, went quiet after 9 days.",
  "history": [{ "direction": "INBOUND", "body": "...", "at": "..." }] }
```
Harvey applies: `domain = _clean_domain(website)`; `company_id = add_company(Company(name, domain, website, location, phone, source="openreply", source_url=f"{base_url}/whatsapp", external_id=f"openreply:wa:{whatsAppLeadId}", notes))`. Prospect: if `email` given and `get_prospect_by_email(email)` exists → reuse (result `"existing": true`). Else `Prospect(company_id, first_name, last_name, title (default "Owner"), email, email_status="guess", phone, source="openreply", source_url=same, status="new", score=70, company=name, personalization_notes="Reached us on WhatsApp via Instagram (@ig) on <date>; last 3 messages: ...")` then `add_prospect`. Email handling: if `email` given → `status = await verify_known_email(email, env)` (new 12-line public wrapper in `email_finder.py` around `get_mx_host` / `classify_mx` / `_verify_candidate`) and `update_prospect_email(pid, email, status)`; if no email but a domain → `find_email(first, last, domain, verify=True, env=env, state=state)` and store the result honestly (a `guess` is never sent to; Harvey's own rule). Observations (only for confirmed codes): `OR_HANDED_OFF` (value_text=origin), `OR_IG_ENGAGED` (value_text=igUsername) if present, `OR_WHATSAPP_REPLIED` (value_num=len(inbound history)). Result: `{ "prospect": <sync prospect shape>, "companyId": "c_...", "emailStatus": "verified|risky|guess|invalid", "existing": false }`. `Prospect.is_valid()` needs first, last and title, so the UI form requires all three.

---

## 5. Harvey-side changes (fork at `~/Projects/harvey`, additive, upstream-mergeable)

Repository setup (Phase 0, owner runs these; nothing here needs secrets):
- `cd ~/Projects/harvey && git remote add origin git@github.com:angellog/harvey.git` (fork on GitHub first), `git checkout -b openreply-bridge`, commit the two untracked files as the first commit, `git push -u origin openreply-bridge`. Keep `main` tracking `upstream/main`.
- Updating later: `git fetch upstream && git checkout main && git merge --ff-only upstream/main && git checkout openreply-bridge && git merge main && python -m pytest -q && git push`. Everything below is additive (new module, new optional config section, new catalog entries, ~15 lines in `main.py`, ~50 in `cli.py`, 3 small `state.py` helpers), so merges stay trivial. Submit upstream as a PR once stable; the integration is generic ("push to a control plane that speaks this protocol").
- Instances: `git clone ~/Projects/harvey ~/Projects/harvey-feetbit` and later `~/Projects/harvey-vantik`, each `git checkout openreply-bridge`, each with its own `.venv` (`/opt/homebrew/bin/python3.13 -m venv .venv && . .venv/bin/activate && pip install -e ".[dev]"`), `.env`, `harvey.local.yaml`, `data/`. Pulling updates: `git pull` in each instance. (Two clones rather than worktrees so each can sit on the same branch.)

Files and functions:

1. `harvey/integrations/openreply.py` — extend the existing module (keep `canonical_body`, `sign_payload`, `build_headers`, `OpenReplyClient`, `OpenReplyError`, `MAX_BATCH` as they are). Add:
   - `class OpenReplyBridge(state, config, env, client)` with `async def loop(stop_event)` (interval `config.openreply.sync_interval_seconds`, default 60; exponential backoff to 15 min on consecutive `OpenReplyError`; logs once per state change, not every failure) and `async def sync_once() -> dict` running, each in its own try/except so one step's failure never blocks the others: `_heartbeat()`, `_push_prospects()`, `_mint_links()`, `_push_outbox()`, `_push_conversations()`, `_pull_commands()`, `_pull_events()`.
   - Cursors in Harvey `settings`: `openreply.cursor.prospects`, `.outbox`, `.conversations` (ISO `updated_at` of the last fully accepted row; items in `rejected` hold the cursor), `openreply.cursor.events` (int seq), `openreply.last_ok` (ISO), `openreply.last_error`.
   - `_mint_links()`: rows from `get_outbox(status=...)` for `pending_review` and `approved` with `kind == "sequence" and step >= cfg.link_from_step` (plus `kind == "reply"` when `cfg.link_in_replies`), whose body does not contain `f"{base_url}/r/"`. For each, body rewrite by `rewrite_body(body, tracked_url, cfg) -> str`: mode `replace` → `body.replace(cfg.link_url, tracked_url)` if `cfg.link_url` occurs, else fall through to `append` when configured; `append` → `body.rstrip() + "\n\n" + cfg.link_cta.strip() + " " + tracked_url`; `none` → unchanged (minting is skipped entirely). Then `update_outbox_item(id, body=new_body)` and a local `pre_send_check` dry run (log a warning on failure; the real gate runs at send). Destination per `cfg.link_destination`: `"whatsapp"`, `"default"` or `{"url": cfg.link_url}`.
   - Command handlers `apply_command(cmd) -> dict` as specified in §4.5/§4.8, memoised by `idempotencyKey` in `settings`.
   - Event handlers: `LINK_CLICKED` → observation `OR_LINK_CLICKED` (value_num 1, evidence_url `f"{base_url}/r/{slug}"`, run_id `f"openreply-event-{seq}"`, skipped if `observation_exists_for_run(run_id)`); `WHATSAPP_STARTED` → `update_prospect_status(pid, "replied")`, `cancel_pending_outbox_for_prospect(pid, reason="replied_on_whatsapp")`, create `Conversation(prospect_id=pid, channel="whatsapp", intent="interested", stage="engaged", status="replied", thread=[Message(sender="prospect", content=body)])` if none with channel `whatsapp` exists for the prospect (status `replied`, not `open`, so the email Handler is not triggered), observation `OR_WHATSAPP_STARTED`; `WHATSAPP_MESSAGE_IN` → append to that conversation's thread, observation `OR_WHATSAPP_REPLIED`. Cursor advanced after each event (`set_setting`), so a crash re-applies at most one event and every handler is idempotent.
   - Startup guard: if `config.openreply.enabled` and `config.channels.email.require_approval` is False → raise `ConfigError("openreply bridge requires channels.email.require_approval: true")`; if `channels.linkedin.enabled` → log ERROR and report `linkedinEnabled: true` in heartbeats (not fatal; the owner sets it false in Phase 0).
   - Zero model calls in this module. Ever.

2. `harvey/config.py` — add
   ```python
   class OpenReplyConfig(BaseModel):
       enabled: bool = False
       base_url: str = ""                 # https://openreply-azure-six.vercel.app
       sync_interval_seconds: int = 60
       link_mode: str = "append"          # replace | append | none
       link_from_step: int = 2
       link_in_replies: bool = False
       link_destination: str = "whatsapp" # whatsapp | default | url
       link_url: str = ""                 # used by replace, and by destination url
       link_cta: str = "If WhatsApp is easier for you:"
   ```
   with validators (mode/destination enums, `sync_interval_seconds >= 15`, `base_url` https), `HarveyConfig.openreply: OpenReplyConfig = OpenReplyConfig()`, and `EnvConfig.openreply_agent_id` / `openreply_agent_secret` loaded from `OPENREPLY_AGENT_ID` / `OPENREPLY_AGENT_SECRET`. `harvey.yaml` gets a commented `openreply:` block with `enabled: false`; `.env.example` gets the two names with empty values.

3. `harvey/main.py` — after agents are constructed: `bridge = OpenReplyBridge(...) if config.openreply.enabled else None`; `bridge_task = asyncio.create_task(bridge.loop(stop_event))`; cancel and await it after the while loop. The bridge runs during quiet hours too (approvals should land at 23:00 even if nothing sends until 07:00).

4. `harvey/signals.py` — append to `SIGNAL_CATALOG` (category `"openreply"`, collector `"openreply"`, cost_note `"free (pushed by OpenReply)"`): `OR_LINK_CLICKED` (num), `OR_WHATSAPP_STARTED` (bool), `OR_WHATSAPP_REPLIED` (num), `OR_IG_ENGAGED` (text), `OR_HANDED_OFF` (text). They are seeded as `proposed` like everything else and confirmed in Phase 0 with `harvey signals --confirm OR_LINK_CLICKED OR_WHATSAPP_STARTED OR_WHATSAPP_REPLIED OR_IG_ENGAGED OR_HANDED_OFF` (or `--confirm free`, which includes them). The bridge writes an observation only when the code is in `confirmed_signal_codes()`.

5. `harvey/state.py` — three small helpers next to their siblings: `get_rows_updated_since(table, since_iso, limit)` for `prospects`/`outbox`/`conversations` (table name validated against a frozenset), `update_prospect_fields(prospect_id, **fields)` restricted to `{"phone", "score", "personalization_notes", "title", "status"}`, `observation_exists_for_run(run_id) -> bool`. Prospect payloads join `companies` for name/domain/website.

6. `harvey/cli.py` — `harvey bridge status|sync|test`: `status` prints config, last ok/error, cursors, pending command count from the last heartbeat; `sync` runs `sync_once()` once; `test` sends a heartbeat and exits non-zero on failure.

7. `harvey/integrations/email_finder.py` — `async def verify_known_email(email, env) -> str` (public wrapper).

8. Optional but recommended, separate commit, upstream-worthy (`H6`): in `Sender._drain_due`, skip a `sequence` item whose prospect already received a `sent` outbox row in the last 24 h, so a Mac that slept through steps 1 and 2 does not send both minutes apart when it wakes.

9. `tests/test_openreply_bridge.py` — keep the signing tests, add bridge tests (§8).

Config per instance (`harvey.local.yaml`, gitignored):
- FeetBit: `persona` = Angelo / FeetBit wholesale / `wholesale@<dedicated-domain>`; `product.offer.goal: get_reply`; `icp.industries`: sneaker boutiques, sports retailers, gyms, schools, corporate gifting, Kampala/Entebbe/Jinja; `channels.email.max_daily_sends: 15` (ramp), `require_approval: true`, `send_to_risky: false`; `channels.linkedin.enabled: false`; `usage.max_daily_claude_percent: 70`, `quiet_hours` `Africa/Kampala` 21:00–07:30; `openreply.enabled: true`, `link_destination: whatsapp`, `link_from_step: 2`, `link_cta: "If WhatsApp is easier for you:"`.
- Vantik: `product.offer.goal: book_call`, `booking_url` = Cal.com link; `openreply.link_destination: url`, `link_url: <Cal.com>`, `link_mode: replace` (the writer includes the booking URL from `product.offer.booking_url`; the bridge swaps it for the tracked one; `append` is the fallback). `max_daily_claude_percent: 70`.

Launchd (owner, documented in `docs/harvey.md`): `~/Library/LaunchAgents/com.openreply.harvey.feetbit.plist` running `/Users/AngeloKiin/Projects/harvey-feetbit/.venv/bin/harvey run` with `WorkingDirectory` set, `KeepAlive true`, `RunAtLoad true`, logs to `~/Library/Logs/harvey-feetbit.log`; `caffeinate -s` wrapper or `sudo pmset -c sleep 0` so the Mac stays awake on mains power.

---

## 6. UI surface (OpenReply, phone-first)

Navigation: add `{ label: "Outreach", href: "/outreach" }` to `components/sidebar.tsx` between WhatsApp and Settings; add titles to `components/top-bar.tsx`. All pages use the existing `.panel` / `text-muted` / `border-border` vocabulary and the `"use client"` + `fetch` pattern of `app/(dashboard)/whatsapp/page.tsx`. Target 390 px wide first; tables collapse to stacked cards below `sm`.

Pages:
- `app/(dashboard)/outreach/page.tsx` — three stacked sections. (1) **Agents**: one card per `HarveyAgent`: name, online dot (green if `lastSeenAt` < 5 min, amber < 6 h, red otherwise, with "last seen 3d ago"), `sendsToday/maxDailySends`, quota % with reset time, "Sending paused: <reason>" banner with Resume button, Pause button. (2) **Approvals**: one email at a time (upstream's decisions-desk rationale): prospect name, company, title, step n of 3 or "reply", subject, full body in a readable serif-free block, a "link tracked" pill when `trackedLinkId` is set, and three full-width buttons: Approve (sends `approve` with `bodyHash`), Reject (reason sheet), Edit (textarea sheet → `edit` then `approve`). After a decision the card shows "Sent to Harvey — waiting for pickup" until the command is ACKED (poll `/api/outreach/outbox` every 15 s while the page is open), then "Approved · will send on its next heartbeat", then "Sent 10:42". Counter "4 waiting · 1 approved · 38 sent". If the agent is offline: banner "Harvey hasn't checked in for 3 days. Your approvals are saved and will be applied when it is back." (3) **Funnel** per agent: sent → clicked → WhatsApp chats → email replies → meetings (meetings = conversations with `stage` in `closing/closed_won`).
- `app/(dashboard)/outreach/prospects/page.tsx` — list (agent filter, status filter, search by name/company/email); tapping opens `app/(dashboard)/outreach/prospects/[id]/page.tsx`: header, email status, Harvey score, personalization notes, then the **timeline** merging `OutreachEvent`s, outbox items and conversation messages chronologically, with a link to the WhatsApp lead row when attributed.
- `app/(dashboard)/outreach/conversations/page.tsx` — email threads with intent/stage badges; Harvey's queued reply is approved from the Approvals section.
- `app/(dashboard)/whatsapp/page.tsx` — new section **"Gone quiet"** above Chats: leads with `lastInboundAt` older than N days (default 7, selector 3/7/14), no outbound in that window, `harveyProspectId` null, no pending/acked HANDOFF command. Each row has "Hand to Harvey" → bottom sheet: agent (default the only one), first name, last name, title (default "Owner"), company name, website, email (optional), notes (prefilled with last inbound snippet). Submits `POST /api/outreach/handoff`. After ack the row shows "With Harvey as <name> · email <status>". Lead rows attributed to Harvey show "via Harvey · <agent>" in the Campaign column instead of "Unattributed".
- `app/(dashboard)/settings/page.tsx` — new section **"Harvey agents"** (component `components/harvey-agents.tsx`, modelled on `components/whatsapp-numbers.tsx`): list; "Add agent" form (name; WhatsApp number from `/api/whatsapp/sessions` ready sessions, optional; prefilled message; greeting; default destination URL); on create, a one-time panel shows the three env variable NAMES with the values `OPENREPLY_BASE_URL=<this origin>`, `OPENREPLY_AGENT_ID=<id>`, `OPENREPLY_AGENT_SECRET=<shown once>` and a copy button, plus the `harvey.local.yaml` `openreply:` snippet. Revoke button (status REVOKED; signatures rejected). The implementer never pastes these anywhere; the owner does, on the Mac.
- `app/(dashboard)/diagnostics/page.tsx` — new card row "Harvey agents" (online/offline per agent) fed by `app/api/admin/diagnostics/route.ts`, and the existing timeline naturally shows `HARVEY` events.

Session-auth API (`getCurrentWorkspaceId()` like every existing route; writes require `canManageWorkspace(role)` via `getCurrentWorkspaceContext()`):
- `GET/POST /api/outreach/agents`, `PATCH/DELETE /api/outreach/agents/[id]` (DELETE = revoke), `POST /api/outreach/agents/[id]/sending { action: "pause"|"resume", reason? }`.
- `GET /api/outreach/outbox?status=&agentId=&page=` — items joined with their latest non-terminal command (`pendingCommand: { type, status }`).
- `POST /api/outreach/outbox/[id]/decision { action: "approve"|"reject"|"edit"|"approve_all", bodyHash?, reason?, subject?, body? }` → creates `HarveyCommand`(s) with the idempotency keys of §4.5; returns the command(s). `approve` requires `bodyHash === item.bodyHash` (409 otherwise: "This email changed since you opened it").
- `GET /api/outreach/prospects`, `GET /api/outreach/prospects/[id]` (with timeline), `GET /api/outreach/conversations`, `GET /api/outreach/funnel`, `GET /api/outreach/cold-leads?days=7`, `POST /api/outreach/handoff { whatsAppLeadId, agentId, contact, company, notes }` (builds `history` from the last 10 `WhatsAppMessage`s, `igUsername` from the attributed `DmLog.commenterName` when the lead's `automationId` and phone allow it — otherwise omitted).

Library code: `lib/harvey/signature.ts`, `lib/harvey/auth.ts`, `lib/harvey/schemas.ts` (zod), `lib/harvey/sync.ts` (upsert logic, derived events), `lib/harvey/links.ts` (mint), `lib/harvey/commands.ts` (create with idempotency, pull, ack), `lib/harvey/events.ts` (`recordOutreachEvent`), `lib/harvey/agent-watch.ts` (worker interval: every 10 min, for ACTIVE agents with `lastSeenAt < now - 6h` write one hourly-deduped `OperationalEvent` WARNING `Harvey agent "<name>" last checked in <n>h ago — approvals wait until it is back`; also expire commands), `lib/harvey/secrets.ts` (`generateAgentSecret()` 32 random bytes base64url; `getAgentSecret(agent)` via `decryptToken`). `lib/env.ts`: no new required variables (the agent secret lives in the DB); `getMissingHarveyEnv()` returns `["ENCRYPTION_KEY"]` when absent because agent creation needs it.

---

## 7. Build order

Each phase is independently shippable and ends with an acceptance test. Vitest count today: 175 passing (181 `it(` blocks across 18 files); each phase adds tests and must leave `npm run typecheck && npm run lint && npm test && npm run build` green and `python -m pytest -q` green in the fork.

**Phase 0 — Owner prerequisites (no OpenReply code).** Fork `ethanplusai/harvey` to `angellog/harvey`; add `origin`, branch `openreply-bridge`, commit the two WIP files. `brew install python@3.13`; create the `harvey-feetbit` clone and venv; `claude -p "say hi"` works; `harvey train https://feetbit.sneakers` (or legitsneakers.ug); `harvey signals --confirm free`; `harvey discover` (OpenStreetMap, free) for Kampala sneaker/sports retailers to seed companies; set `channels.linkedin.enabled: false`. Owner buys a dedicated sending domain per brand, creates the mailbox, sets SPF/DKIM/DMARC, starts warm-up (2–4 weeks; this clock starts now and is the real critical path), configures Gmail OAuth or SMTP in the instance `.env` himself, `harvey gmail auth`. Acceptance: `harvey status` shows companies > 0 and no config errors; a test email from the mailbox to the owner's personal address lands in Inbox, not Spam, with DKIM pass.

**Phase 1 — Control plane: agents, heartbeat, mirrors, approve-from-phone.** OpenReply: migration 1; `lib/harvey/{signature,auth,schemas,sync,commands,secrets,agent-watch}.ts`; routes `heartbeat`, `sync`, `commands/pull`, `commands/ack`; `/api/outreach/agents*`, `/api/outreach/outbox*`, `/api/outreach/agents/[id]/sending`; `/outreach` page (Agents + Approvals, funnel limited to sent); Settings "Harvey agents"; sidebar/top-bar; worker hook in `worker/dm-worker.ts`; diagnostics card; `.env.example` unchanged (document in `docs/harvey.md`). Harvey: `OpenReplyConfig`, bridge loop with heartbeat/push/commands (no links, no events yet), `main.py` hook, `harvey bridge` CLI, `state.py` helpers, tests. Acceptance: with a test prospect whose email is the owner's second mailbox (inserted via `harvey`'s normal flow or a tiny seed script in the instance, never in the repo), Harvey stages a campaign; within 60 s the email appears under Approvals on the phone; tap Approve; within one heartbeat it is `SENT` on the phone and in the test mailbox; tapping Pause stops the next drain (heartbeat shows `sendingPaused`), Resume restarts it; killing `harvey run` turns the agent card amber then red and, after 6 h (or with the threshold temporarily lowered), writes the Diagnostics warning; approvals made while it is down are applied when it restarts.

**Phase 2 — Closed attribution loop.** OpenReply: migration 2; `links` and `events/pull` routes; `/r/[slug]` and `lib/whatsapp/inbound.ts` changes (Harvey ref → `harveyAgentId`/`harveyProspectId`, greeting auto-reply from `agent.whatsappGreeting` via `agent.whatsappSessionId`, `WHATSAPP_STARTED` on lead creation and `WHATSAPP_MESSAGE_IN` on later inbound messages, still exactly one outbound ever per lead); `funnel`/`stats` filters; derived `EMAIL_SENT`/`EMAIL_REPLIED` events in `sync`; prospect pages with timeline; full funnel. Harvey: `_mint_links` + `rewrite_body`, `_pull_events` handlers, signal catalog entries. Acceptance (owner, phone + test mailbox): step-2 email arrives containing exactly one link, `https://openreply-azure-six.vercel.app/r/<slug>`; tapping it opens WhatsApp with "Hi! I got your email (ref: <slug>)" prefilled; sending it creates a `WhatsAppLead` attributed "via Harvey · feetbit-wholesale", the greeting arrives once; the prospect timeline shows EMAIL_SENT → LINK_CLICKED → WHATSAPP_STARTED; within 60 s Harvey's prospect is `replied`, its step-3 outbox row is `cancelled` with error `replied_on_whatsapp`, a `whatsapp` conversation exists, and `observations` contains `OR_LINK_CLICKED` and `OR_WHATSAPP_STARTED` for that prospect. The Instagram dashboard's click totals are unchanged by the test.

**Phase 3 — Reverse flow: cold WhatsApp lead → Harvey.** OpenReply: `/api/outreach/cold-leads`, `/api/outreach/handoff`, "Gone quiet" section and sheet, ack handling that creates the mirror and links the lead. Harvey: `HANDOFF_LEAD` handler, `verify_known_email`, observations. Acceptance: hand off a real quiet lead (a boutique that asked about wholesale) with name, title, company, website; within 60 s `harvey status` shows a new company (`source openreply`) and prospect; the lead row shows "With Harvey · email verified|guess"; on Harvey's next write cycle the staged email's personalization references the WhatsApp context; it appears under Approvals. If the email is a `guess`, nothing is staged and the row says so — that is correct behaviour, not a bug.

**Phase 4 — Second brand, polish, docs.** Vantik instance (`link_destination: url`, Cal.com, `link_mode: replace`); agent filter everywhere; conversations page; `docs/harvey.md` runbook (launchd plists, keep-awake, update procedure, what to do when the agent goes red, how to rotate a secret); `docs/stack.md` and `README.md` sections; `.env.example` in the fork. Acceptance: two agents online in one workspace; a Vantik step-1 email's booking link is a tracked link that 302s to Cal.com and logs `LINK_CLICKED` with `instagramAccountId: null`; both funnels render; `npm test` and `pytest` green.

**Phase 5 — Hardening (optional, independently valuable).** Upstream `H6` drain spacing; Cal.com booking webhook → `OutreachEvent MEETING_BOOKED` (new enum value) and Harvey conversation stage `closed_won`; Harvey Analyst including OpenReply events in its idle report; secret rotation endpoint.

---

## 8. Test plan

Vitest (`__tests__/`, `environment: node`, mock `@/lib/db/client` with `vi.hoisted` like `redirect.test.ts`; use `NextRequest` where a route reads `nextUrl`):
- `harvey-signature.test.ts`: golden vector from §4.1 verifies; wrong secret, altered body, altered timestamp, `|skew| > 300` all fail; length-mismatch does not throw; revoked agent rejected; `kind` mismatch → 409.
- `harvey-sync.test.ts`: prospects/outbox/conversations upsert by `(agentId, harveyId)`; stale `updatedAt` reported and skipped; outbox for unknown prospect rejected; 201 items → 413; `bodyHash` computed; `SENT` transition writes `EMAIL_SENT`; new prospect message writes `EMAIL_REPLIED`; `trackedLinkId` resolved from `(agentId, harveyOutboxRef)`.
- `harvey-commands.test.ts`: create with duplicate idempotency key returns the existing command; pull marks DELIVERED and increments attempts; redelivery after 10 min; `attempts > 20` → FAILED; expiry; ack ok/noop/failed; acking twice is a no-op; HANDOFF ack creates the mirror and links the lead and writes `LEAD_HANDED_OFF`; `approve` decision with wrong `bodyHash` → 409.
- `harvey-links.test.ts`: idempotent mint; `whatsapp` destination built with `buildWhatsAppHandoffTemplate` from agent settings and contains `%7Bref%7D`/`{ref}`; `default` destination; missing phone → rejected item.
- `redirect.test.ts` (extend): Harvey link → `linkClick.create` with `automationId: null`, `instagramAccountId: null`, `LINK_CLICKED` event with step; automation link behaviour unchanged.
- `harvey-inbound.test.ts`: ref from a Harvey link attributes the lead to agent and prospect, sends the greeting once from `agent.whatsappSessionId`, no greeting when null, `WHATSAPP_STARTED` then `WHATSAPP_MESSAGE_IN`; "first ref wins" still holds; automation refs unchanged (existing `whatsapp.test.ts` stays green).
- `harvey-agent-watch.test.ts`: 6 h threshold, hourly dedupe, command expiry.
- `harvey-cold-leads.test.ts`: window logic, exclusion of handed-off and pending-handoff leads.
- `env.test.ts` (extend): `getMissingHarveyEnv()`.

pytest (fork, `tests/test_openreply_bridge.py`, `pytest-asyncio`, temp SQLite via the `state` fixture pattern of `test_outbox_native.py`, HTTP via `httpx.MockTransport`):
- Existing signing tests unchanged.
- `rewrite_body`: replace hits/misses, append adds exactly one link, `none` leaves body, step gating, result passes `pre_send_check` (one link, no merge tags).
- Push cursors advance only on full acceptance; `rejected` holds the cursor; `MAX_BATCH` paging.
- Commands: approve idempotent by key; `body_changed`; reject on `sent` → noop; edit only when pending; pause/resume toggle `sending_paused`; handoff builds a valid `Prospect`, dedups on email, records observations only for confirmed codes.
- Events: `WHATSAPP_STARTED` → status `replied`, queued rows cancelled, one `whatsapp` conversation, observation keyed by run_id; re-applying the same seq is a no-op; `LINK_CLICKED` twice → one observation.
- Startup guard: `require_approval: false` with bridge enabled raises `ConfigError`.
- Zero `Brain.think` calls: the bridge is constructed with a `Brain` stub that raises on `think`.

Integration (local): `docker-compose up -d` in openreply, `npm run db:migrate && npm run dev`, create an agent in Settings, paste the three env values into the instance `.env` on the same machine, set `openreply.base_url: http://localhost:3000`, `harvey bridge test` → `success: true`; `harvey bridge sync` with a seeded outbox row → item appears at `http://localhost:3000/outreach`.

Manual end-to-end script (the owner, Phase 2 done; takes ~15 minutes):
1. On the Mac: `launchctl kickstart -k gui/$(id -u)/com.openreply.harvey.feetbit`; on the phone open `/outreach`; the agent card goes green within a minute.
2. In Settings → Harvey agents confirm the FeetBit agent has the spare WhatsApp number and a greeting.
3. On the Mac, add yourself as a prospect in the normal way (the `harvey` CLI or Scout) with your test mailbox and `email_status verified`; wait for the Writer (next heartbeat) — Approvals shows email 1.
4. Approve email 1 from the phone. Check the test mailbox: received, DKIM pass, no link (step 1).
5. Wait for email 2 to be staged (or set `link_from_step: 1` for the drill); approve; it arrives with exactly one `/r/` link.
6. Tap the link on the phone: WhatsApp opens with the prefilled "(ref: …)" text; send it.
7. Within a minute: WhatsApp page shows the chat "via Harvey · feetbit-wholesale" and the greeting was delivered once; Outreach → Prospects → you: timeline EMAIL_SENT ×2, LINK_CLICKED, WHATSAPP_STARTED; the step-3 email shows `CANCELLED · replied_on_whatsapp`.
8. Reply to email 1 from the test mailbox; next heartbeat the conversation appears with an intent, and Harvey's drafted reply shows under Approvals; reject it with a reason; it shows REJECTED.
9. Tap Pause; `harvey bridge status` on the Mac shows `sending_paused: paused from OpenReply`; Resume.
10. Close the Mac lid for 10 minutes (or `launchctl stop`); approve something; the card turns amber, the approval shows "waiting for pickup"; start Harvey; it sends.

---

## 9. Assumptions and open questions

Assumptions (what breaks if wrong):
- A1. One OpenReply workspace holds both brands and both Instagram accounts (the UI has no workspace switcher; `getCurrentWorkspaceId` returns the first membership). If Vantik needs its own workspace, agents are workspace-scoped already; only the owner's login flow would need a switcher — out of scope.
- A2. The two WIP files in `~/Projects/harvey` are yours and may be committed/extended; the plan keeps their signing scheme. If they are discarded, the scheme in §4.1 still stands.
- A3. Python 3.13 via Homebrew installs cleanly and Playwright wheels exist for it (only needed for LinkedIn, which stays off; `pip install -e .` still pulls the dependency). If 3.13 is unavailable, 3.12 is fine; 3.14 is untested by upstream.
- A4. The Claude Code CLI 2.1.300 supports `--tools ""` and `--strict-mcp-config` as `brain.py` expects (upstream 0.3.0 was released 2026-10-13, one day before this plan). If not, Harvey's own `preflight` reports it; nothing in the bridge depends on it.
- A5. `claude -p` headless calls from launchd inherit the Keychain-stored login. If launchd sessions cannot read the Keychain item, run Harvey from a user-session login item (Automator/`open -a Terminal`) instead; Harvey's `quota.py` already handles the keychain lookup.
- A6. Harvey's Writer does not include a URL in email 1 by default; the bridge appends the tracked link from step 2 (`link_from_step: 2`). If the owner wants a link in email 1, set `1`; deliverability cost is his call.
- A7. The spare OpenWA number used for FeetBit links is the same session already receiving Instagram-originated chats, so `inbound.ts`'s "one auto-reply per lead" invariant covers both sources.
- A8. Harvey instances share one Claude Max subscription; both set `max_daily_claude_percent: 70`; combined bursts are bounded by Harvey's quota check reading the same windows. If quota exhaustion becomes frequent, lower FeetBit to 50 (wholesale is lower-volume).
- A9. `OutreachEvent.seq` as `Int @default(autoincrement())` is accepted by Prisma 7 on Postgres (it maps to `SERIAL`). If the implementer prefers `BigInt`, the JSON must stringify it; stick to `Int`.
- A10. Vercel function duration suffices for a 200-item `sync` (Prisma upserts in a transaction, well under 10 s). If not, lower `MAX_BATCH` to 100 on both sides.
- A11. The owner has or will register a Cal.com event for Vantik; the plan only needs its URL.

Open questions (decide before the named phase):
- Q1 (Phase 0). Exact sending domains and mailbox provider per brand (Gmail API vs SMTP/IMAP). Deliverability work cannot start without them.
- Q2 (Phase 0). FeetBit wholesale ICP wording for `harvey.local.yaml` and the first discovery geography (Kampala only, or Entebbe/Jinja/Mbarara too). OpenStreetMap coverage of Ugandan boutiques is likely thin; budget a small DataForSEO or Serper spend after the free pass.
- Q3 (Phase 2). Should `WHATSAPP_MESSAGE_IN` be pushed for every message, or only the first N per lead? Default: every inbound message, capped at 50 per lead (payload bodies truncated to 500 chars).
- Q4 (Phase 3). Whether to also surface Instagram-only cold leads (`DmLog` commenters who never clicked) in "Gone quiet". They have no email or phone, so a hand-off needs the owner to supply everything; default: no, WhatsApp leads only.
- Q5 (Phase 4). Vantik's "reply" emails: should tracked links be injected into Harvey's replies (`link_in_replies`)? Default false; a reply already has the thread.
- Q6 (Phase 5). Cal.com webhook secret and event shape for `MEETING_BOOKED`.
- Q7. Retention: `OutreachEvent` grows unbounded; propose pruning rows older than 365 days in the agent watch. Not implemented until it matters.

Explicit non-goals, stated once: no matching of arbitrary Instagram commenters to companies (no join key exists; only handed-off leads carry `OR_IG_ENGAGED`); no Harvey-initiated WhatsApp or Instagram messages, ever; no LinkedIn.

---

## 10. Risks

Compliance and platform policy:
- Outbound Instagram DMs to people who have not messaged first are not permitted by the Meta Graph API outside the reply window. Nothing in this plan sends an Instagram DM; the reverse flow is email-only and the handed-off lead's Instagram username is used only as context. Stated here so nobody "fixes" it later.
- WhatsApp: OpenWA drives an unofficial client on a spare number; sending to strangers is an account-ban risk with no appeal. Policy: Harvey never sends WhatsApp. The only WhatsApp message OpenReply sends is the single greeting after the prospect messages first, from the session they messaged, and `inbound.ts` keeps the one-outbound-per-lead invariant. If the official Cloud API is adopted later, business-initiated messages need approved templates; out of scope.
- Cold email: the owner is the sender of record. Per brand: dedicated secondary domain, SPF/DKIM/DMARC, 2–4 weeks warm-up, start at 10–20/day (`max_daily_sends: 15`), raise by ~5/day; physical address in the footer (set in the persona/footer before the first campaign; verify on the first approved draft); honour opt-outs instantly (Harvey's `OPT_OUT_PATTERNS` do, and the UI shows `opted_out` prospects); B2B only, and a defensible reason for each recipient (Harvey's ICP + the "Gone quiet" hand-off provide it). Recipients in the EU/UK fall under GDPR/PECR; Uganda's Data Protection and Privacy Act 2019 applies to business contacts' personal data — keep purpose narrow and deletion easy (reject → Harvey marks `lost`; a "forget" is a manual SQLite delete today, Q7-adjacent). None of this is legal advice.
- LinkedIn automation stays off (`channels.linkedin.enabled: false`, `LINKEDIN_*` blank); the heartbeat reports it and OpenReply warns if it is ever turned on.
- Secrets: agent secrets are generated server-side, shown once, stored encrypted; the owner pastes them into the Mac's `.env` himself along with mail and verifier keys. `.env*` is gitignored in both repos; `.env.example` carries names only. The implementer never enters any third-party credential into any dashboard or file.
- Subscription terms: Harvey uses the owner's own Claude Max login on the owner's own machine, which is the use the subscription is for; keeping it off cloud hosts is deliberate.

Deliverability: a link in a cold email lowers reply rates; the plan defaults to no link in email 1. Bounce protection is Harvey's (`max_bounce_rate`, kill switch); the pause state is visible on the phone. Mitigation if inbox placement degrades: halve volume, check DMARC reports, keep sending from the dedicated domain only.

Mac-asleep problem: if the Mac sleeps, nothing sends and nothing syncs; approvals queue in Postgres (7-day expiry) and apply on wake; the agent card turns red and Diagnostics warns after 6 h. Mitigations: `pmset`/`caffeinate`, launchd `KeepAlive`, a UPS (Kampala power), and — the real fix — a Mac mini or any always-on Linux box at home with `claude login` done once (Linux stores credentials in `~/.claude/.credentials.json`, which the CLI refreshes in place). Waking after days can make steps 1 and 2 due simultaneously; `H6` in §5 prevents same-day double sends.

Cost: OpenReply side is free-tier compatible (a few hundred rows a day). Harvey's paid stages are discovery only (DataForSEO ~$0.37/1000, Serper 2,500 free) and verifier credits (Reoon 600/mo free, ZeroBounce 100/mo free). Claude quota: Harvey yields to the owner's own usage via the 70% gate; if the owner's heavy Claude Code sessions starve Harvey, it simply sleeps and the heartbeat says so.

Data loss and divergence: Harvey's SQLite is the operational state; Postgres holds a near-complete mirror (prospects, every outbox row, conversations, every decision and attribution event). Losing the Mac loses in-flight cursors, `settings`, companies' observations and the pattern cache — rebuildable by re-discovery, not by the mirror. Nightly `sqlite3 data/harvey.db ".backup"` to iCloud is a one-line launchd job in the runbook. Divergence risk: OpenReply never writes to mirrored fields directly, only via commands that Harvey applies and then syncs back, so Harvey remains the single writer of its own rows; `harveyUpdatedAt` guards out-of-order batches.

Ban/abuse surface: `/api/harvey/v1/*` is unauthenticated to the public except by HMAC; a revoked agent is rejected before any DB write; failed signatures are logged with dedupe, never with bodies.

---

## Appendix A — Environment variable names

OpenReply (Vercel + Railway): no new variables. `ENCRYPTION_KEY` (existing) encrypts agent secrets; `NEXTAUTH_URL` (existing) is the tracked-link base.

Harvey instance `.env` (names only; owner fills): `OPENREPLY_AGENT_ID`, `OPENREPLY_AGENT_SECRET`, plus upstream's mail/verifier/discovery keys. `OPENREPLY_BASE_URL` lives in `harvey.local.yaml` as `openreply.base_url` (not a secret).

## Appendix B — Files to create or change

OpenReply (`/Users/AngeloKiin/Projects/openreply`): `prisma/schema.prisma`; `prisma/migrations/20261020120000_harvey_control_plane/migration.sql`; `prisma/migrations/20261027120000_harvey_attribution/migration.sql`; `lib/harvey/{signature,auth,schemas,sync,links,commands,events,secrets,agent-watch}.ts`; `app/api/harvey/v1/{heartbeat,sync,links}/route.ts`, `app/api/harvey/v1/commands/{pull,ack}/route.ts`, `app/api/harvey/v1/events/pull/route.ts`; `app/api/outreach/agents/route.ts`, `app/api/outreach/agents/[id]/route.ts`, `app/api/outreach/agents/[id]/sending/route.ts`, `app/api/outreach/outbox/route.ts`, `app/api/outreach/outbox/[id]/decision/route.ts`, `app/api/outreach/{prospects,conversations,funnel,cold-leads,handoff}/route.ts`, `app/api/outreach/prospects/[id]/route.ts`; `app/(dashboard)/outreach/page.tsx`, `app/(dashboard)/outreach/prospects/page.tsx`, `app/(dashboard)/outreach/prospects/[id]/page.tsx`, `app/(dashboard)/outreach/conversations/page.tsx`; `components/harvey-agents.tsx`, `components/outreach-approval-card.tsx`, `components/cold-leads.tsx`; edits to `app/r/[slug]/route.ts`, `lib/whatsapp/inbound.ts`, `app/api/whatsapp/funnel/route.ts`, `app/api/dashboard/stats/route.ts`, `app/api/admin/diagnostics/route.ts`, `app/(dashboard)/whatsapp/page.tsx`, `app/(dashboard)/settings/page.tsx`, `app/(dashboard)/diagnostics/page.tsx`, `components/sidebar.tsx`, `components/top-bar.tsx`, `worker/dm-worker.ts`, `lib/env.ts`; tests listed in §8; `docs/harvey.md`, `docs/stack.md`, `README.md`.

Harvey fork (`/Users/AngeloKiin/Projects/harvey`, branch `openreply-bridge`): `harvey/integrations/openreply.py` (extend), `harvey/config.py`, `harvey/main.py`, `harvey/cli.py`, `harvey/signals.py`, `harvey/state.py`, `harvey/integrations/email_finder.py`, `harvey/agents/sender.py` (H6, optional), `harvey.yaml`, `.env.example`, `tests/test_openreply_bridge.py`.

