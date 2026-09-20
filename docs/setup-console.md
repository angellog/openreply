# The Setup Console

A browser UI at `/setup` for configuring an OpenReply instance, verifying it end
to end, and pointing it at the posts you want watched.

`docs/setup.md` is still the reference for the whole deployment, especially the
Meta side. The console does not replace it — it removes the retyping, tells you
which step is currently broken, and gives you a way into the dashboard before
email works.

```
http://localhost:3000/setup
```

## What it does

**Overview.** Ten live checks: required environment variables, Postgres, pending
migrations, Redis, the send queue, the DM worker's heartbeat, Resend, whether
your public URL is actually reachable, the webhook handshake, and the state of
each connected Instagram account. Anything that is not passing comes with what to
do about it and a copyable command.

**Environment.** Every variable, grouped and explained, written back to `.env`.
Secrets arrive masked and are only revealed when you click Reveal. `NEXTAUTH_SECRET`,
`ENCRYPTION_KEY`, and `WEBHOOK_VERIFY_TOKEN` have Generate buttons that produce a
correctly-shaped value — `ENCRYPTION_KEY` in particular has to be exactly 64 hex
characters or the app throws on boot.

**Meta app.** A seven-step checklist with every URL Meta asks for derived from
your live configuration: the OAuth redirect URI, the deauthorize and data
deletion URLs, the webhook callback, and the verify token. Copy buttons on all of
them, because these have to match character for character. The step notes carry
the specific wrong turns — the Instagram app ID is not the Facebook app ID at the
top of the dashboard, and `FACEBOOK_APP_SECRET` is not the Instagram app secret.

**Sign in.** OpenReply authenticates with email magic links, so reaching the
dashboard normally requires a working Resend key and a verified sending domain —
which is one of the things you came here to configure. The console breaks that
loop by writing a session row and cookie directly. See
[Local sign-in](#local-sign-in) below for why this is safe here and not
elsewhere.

**Targets.** Connect Instagram accounts, and add the things being watched: an
account, the post or posts, the keywords, the DM, an optional public reply, and
an optional tracked link. Pause, activate, or delete any of them.

## Targets are campaigns

A target is one `Automation` row — the same record the dashboard calls a
campaign. Add one here and it appears under Campaigns; edit it there and it shows
up here. Two names for one thing, because during setup you are thinking about
where to point this, not about marketing.

Each target picks one of three triggers:

| Trigger | Behaviour |
| --- | --- |
| One specific post | Only comments on the post you pick. |
| Any post on the account | Every post, including ones published later. |
| The next reel you post | Binds to the next reel published, then behaves like a specific post. |

Exactly one of these is ever stored, so the worker cannot disagree with what the
UI showed you.

Targets are per account, and accounts are per workspace. Connect as many
Instagram accounts as you run; each keeps its own token and its own share of
Meta's 750-private-replies-per-hour cap.

## Access control

The console can write `.env`, reveal secrets, and mint a signed-in session
without a password. Those are the right powers on a machine you control and the
wrong ones on a public deployment, so:

| Environment | Default | To open it |
| --- | --- | --- |
| Development | Open | — |
| Production | Closed | `SETUP_CONSOLE_ENABLED=true` **and** `SETUP_CONSOLE_TOKEN` (24+ characters), then visit `/setup?token=…` |

`SETUP_CONSOLE_ENABLED=false` turns it off everywhere, including in development,
and wins over everything else.

When the console is closed, the page never ships its client bundle and every
`/api/setup/*` route returns 404 — a wrong token returns 401, compared in
constant time.

Generate a production token with:

```bash
openssl rand -hex 32
```

## Local sign-in

The Sign in tab creates a user, a workspace, and a session, then sets the Auth.js
session cookie. Auth.js is configured with the database session strategy, so a
session is a row in `Session` plus a cookie holding its token; both are written
directly. The result is a real session, indistinguishable from one earned through
a magic link.

This is, by design, authentication with no authentication. It is gated by the
same rule as the rest of the console, which is why the console is closed in
production by default. Use the magic-link flow for anyone who is not you.

## Restarts

Some values are read once when the process boots — the Prisma client, the Redis
connection, the auth secret, and the webhook verify token. After saving any of:

```
DATABASE_URL  REDIS_URL  NEXTAUTH_URL  NEXTAUTH_SECRET
ENCRYPTION_KEY  RESEND_API_KEY  EMAIL_FROM
```

the console says a restart is needed, and the Overview tab flags any variable
that differs between `.env` and the running process. The webhook handshake check
is the one that catches this in practice: it fails while the file on disk and the
running server disagree about `WEBHOOK_VERIFY_TOKEN`.

## Editing `.env` by hand

The console is not the owner of that file. It parses `.env` into lines, patches
only the values you changed, and writes the result back — comments, ordering, and
variables it does not know about all survive. Round-tripping a file without
changing anything produces byte-identical output.

Writes are atomic (temp file plus rename) and the previous contents are copied to
`.env.backup` first, because a half-written `.env` boots the app with half its
configuration and the cause is not obvious.

If the same key is assigned twice, the console updates the one dotenv actually
honours (the last) and comments out the shadowed one, so the file cannot end up
disagreeing with itself.

## Local services without Docker

`docker-compose.yml` is the documented path, but any Postgres and Redis will do:

```bash
brew services start postgresql@16
brew services start redis
createdb openreply
npm run db:migrate
```

Then set `DATABASE_URL` to `postgresql://$(whoami)@localhost:5432/openreply` and
`REDIS_URL` to `redis://localhost:6379` on the Environment tab.

## Two processes, always

The console's worker check exists because this is the single most common way a
working setup looks broken:

```bash
npm run dev      # web app, dashboard, webhook receiver
npm run worker   # sends the DMs
```

If comments arrive and no DM ever does, the worker is the first thing to check.
Without it, jobs queue up and nothing drains them.

## API

Every route is gated as described above and returns `Cache-Control: no-store`.

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/setup/state` | The full snapshot: fields (secrets masked), checks, Meta wizard, accounts, targets |
| `POST` | `/api/setup/env` | Save `{ updates: { KEY: value } }`; only declared fields are writable |
| `PUT` | `/api/setup/env` | Reveal one secret in the clear |
| `POST` | `/api/setup/generate` | Mint a value for a field with a generator |
| `POST` / `DELETE` | `/api/setup/session` | Create or destroy a local session |
| `GET` / `POST` / `PATCH` / `DELETE` | `/api/setup/targets` | Target CRUD |

In production, pass the token as `?token=…` or an `x-setup-token` header.

## Tests

```bash
npm test
```

`__tests__/setup-*.test.ts` covers the `.env` parser and writer (including
round-trip fidelity and duplicate-key handling), the access rules, field
validation against the runtime schema in `lib/env.ts`, target trigger mapping,
and the Meta URL derivation.
