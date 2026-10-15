# Outbound email with Harvey

OpenReply handles inbound: someone comments, you DM them, they land in
WhatsApp. Harvey handles the other direction — it finds businesses, reads
their sites, writes cold emails that reference something specific, and works
replies toward a meeting.

Harvey runs on your Mac, because its model backend is your logged-in Claude
CLI rather than a metered API. That is also its one inconvenience: approving
cold email would mean sitting at that Mac. This bridge removes that. Harvey
pushes what it is doing to OpenReply and collects your decisions from it, so
you approve from your phone.

**Nothing listens on your Mac.** Harvey only ever calls out. There is no port
to forward, no tunnel, no ngrok.

---

## What you need first

| | |
|---|---|
| Python 3.11+ | This Mac has `python3.12` (3.12.12). **`python3` is 3.9 and will not work** — use `python3.12` in every command below. |
| Claude CLI, logged in | Already present: `claude` 2.1.300. Check with `claude --version`. |
| A dedicated sending mailbox | **Not your main business address.** See "Deliverability" below — this matters more than the software. |
| Free disk | Harvey's venv is ~250 MB. This Mac has been running at 99% full; check `df -h /System/Volumes/Data` first. |

---

## 1. Pair the agent

In OpenReply, open **Outreach**. Under Agents, type a short name and press
**Pair**. Use one agent per brand:

- `feetbit-wholesale` — sneaker wholesale, hands off to WhatsApp
- `vantik` — advisory, hands off to a Cal.com booking page

You get an id and a secret, **shown once**. Pairing again with the same name
issues a fresh secret and retires the old one, which is also how you recover
from a leak.

## 2. Set up that brand's Harvey

One checkout per brand, so each has its own database, mailbox and config:

```bash
git clone ~/Projects/harvey ~/Projects/harvey-feetbit
cd ~/Projects/harvey-feetbit && git checkout feat/openreply-bridge
python3.12 -m venv .venv && ./.venv/bin/pip install -e '.[dev]'
cp .env.example .env
```

Put the two lines from step 1 into `.env`:

```
OPENREPLY_AGENT_ID=...
OPENREPLY_AGENT_SECRET=...
```

Then in `harvey.yaml` (or `harvey.local.yaml`, which is gitignored):

```yaml
openreply:
  enabled: true
  base_url: "https://openreply-azure-six.vercel.app"
  link_destination: "whatsapp"   # "default" for Vantik's booking page
  link_from_step: 2
  link_cta: "If WhatsApp is easier for you:"

channels:
  email:
    require_approval: true       # required; Harvey refuses the bridge without it
    max_daily_sends: 15          # start low, ramp over weeks
    send_to_risky: false
  linkedin:
    enabled: false               # automating LinkedIn breaks their terms
```

Harvey **refuses to run the bridge** if `require_approval` is false, and says
why. Approving mail that already went out is theatre.

## 3. Set where the links point

Back in OpenReply, set the agent's handoff — a WhatsApp number for FeetBit, a
booking URL for Vantik. This lives in OpenReply and not in Harvey's config on
purpose: a stolen Harvey secret then cannot repoint a link on your own domain
at a number you never chose.

## 4. Train and run

```bash
cd ~/Projects/harvey-feetbit
./.venv/bin/harvey train https://your-site.example
./.venv/bin/harvey signals --confirm free
./.venv/bin/harvey discover
./.venv/bin/harvey run
```

Within a minute, Outreach in OpenReply shows the agent online. Emails appear
under Approvals as Harvey writes them.

---

## What happens when you tap Approve

1. OpenReply queues a command. It does not reach your Mac directly.
2. Harvey collects it on its next sync (60 s by default) and approves that
   outbox row. The card changes to "Harvey picked this up".
3. Harvey's own pre-send gate runs — merge tags, banned phrases, length, link
   count, address deliverability — and then it sends.
4. The card shows "Sent".

**If the Mac is asleep**, the decision waits. The page says so, naming how
long the agent has been quiet. Decisions **expire after three days**, because
an approval given on Monday should not fire on Thursday against a prospect
whose situation has moved on — you will be asked again instead.

---

## The loop that makes this worth doing

From step 2 of a sequence onward, Harvey asks OpenReply for a tracked link and
splices it into the email. That link is an ordinary OpenReply tracked link, so:

```
cold email → /r/<slug> → click logged → wa.me with "(ref: <slug>)"
  → prospect sends it → OpenWA webhook → WhatsAppLead, attributed
```

The prospect's reply can arrive on **WhatsApp**, already tied to the exact
email that produced it, and your existing auto-reply fires. None of that is new
code — it is the same machinery the Instagram campaigns use.

Why step 2 and not step 1: Harvey's own `prompts/writer.md` forbids a link in
the first email and `harvey/gate.py` enforces one link per sequence. A cold
opener that asks a question beats one that asks for a click.

---

## Deliverability, which decides whether any of this works

**Full guide with DNS records and a warm-up schedule: [deliverability.md](deliverability.md).**

The software is the easy part. As the sender, you carry the consequences.

- **Use a separate domain.** Not the domain your customers already email. A
  deliverability problem on a cold-email domain should never touch your real
  mail.
- **Set SPF, DKIM and DMARC** on it before sending anything.
- **Ramp.** 10-15 a day for the first fortnight, then up slowly. Harvey's
  `max_daily_sends` caps it; the cap is not a target.
- **One no is enough.** Harvey closes a prospect who says no and stops the
  sequence. Leave that alone.
- **Honour unsubscribes immediately.** Harvey handles the keyword itself.
- CAN-SPAM and GDPR apply to you, not to Harvey.

## What this deliberately does not do

| Not built | Why |
|---|---|
| Outbound Instagram DMs to non-followers | The Graph API only allows replies inside a limited window. There is no API that sends a cold IG DM, so any feature claiming to is a ban waiting to happen. |
| Outbound WhatsApp to strangers | Unsolicited first contact through an unofficial gateway is the fastest way to lose the number. WhatsApp stays inbound-only: the prospect opens the chat by tapping your link. |
| LinkedIn automation | Breaks LinkedIn's terms. Harvey ships it off; leave it off. |

---

## When something looks wrong

**Outreach says the agent has never checked in.** The secret or the base URL is
wrong. `Diagnostics` names the exact reason, because the two failures need
different fixes:

| Reason shown | Means |
|---|---|
| `bad_signature` | Wrong secret. Pair again and update `.env`. |
| `stale_timestamp` | The Mac's clock is more than 5 minutes off. |
| `BAD_AGENT_SECRET` | `ENCRYPTION_KEY` was rotated in OpenReply. Pair again. |
| `AGENT_REVOKED` | You revoked it. Pair again to restore. |

**Harvey is running but nothing appears.** Check `openreply.enabled: true`, and
that `require_approval` is true — Harvey logs a clear error and runs without
the bridge otherwise.

**An email shows "link tracked" but the prospect never reaches WhatsApp.** Open
the tracked URL yourself. It should land on wa.me with `(ref: ...)` in the
prefilled text; if that text is edited away before sending, the chat arrives
unattributed.

## Keeping Harvey up to date

The bridge is additive — one new module, one config section, a few lines in
`main.py` and `state.py` — so merges stay cheap:

```bash
cd ~/Projects/harvey
git fetch upstream
git checkout main && git merge --ff-only upstream/main
git checkout feat/openreply-bridge && git merge main
./.venv/bin/python -m pytest -q
```

Then `git pull` in each per-brand checkout.

---

## Where the addresses come from

Harvey needs email addresses, and the honest ways to get them are narrower than
they look. An Instagram commenter gives you a handle and maybe a WhatsApp
number, never an address, so there is no route from a comment to a cold
sequence. Discovery finds business addresses, which is cold outreach proper.

The third way is the one people actually answer: give something away and ask for
an address in exchange. That is what **Resources** is.

### Setting it up

1. **Outreach → Resources** in the dashboard. Set the public address once, e.g.
   `vantik`. It appears in every link you ever share, so changing it later
   breaks them.
2. Add a resource. A Google Drive link is fine; the file does not have to live
   here. Everything starts as a draft.
3. Publish it. The hub goes live at `/resources/vantik` and each gate at
   `/resources/vantik/<slug>`.
4. Put the hub link in a bio, a Reel caption, or a tracked link from a campaign.
   One link covers everything you have ever published.

### What happens when someone claims one

They type an address, optionally tick a box, and get the link **immediately** on
the page. A copy is emailed at the same time. That combination is deliberate:
showing it means nobody who gave a real address is left waiting on an inbox, and
emailing it means a junk address fails, and a failed address is never used for
anything else.

### The consent rule, which is not negotiable

An address given to get a checklist is consent for that checklist. Nothing more.

A lead is offered to Harvey only when **all three** of these hold:

| Condition | Why it is there |
|---|---|
| They ticked the box | Without it, the address was given for one download. Sending anyway is spam whatever the local law says. |
| The email we sent was accepted | A failed address is junk or mistyped. Feeding it to a cold sequence is how a sending domain earns a bad reputation. |
| It has not been exported before | Offered exactly once. |

The box is **unticked by default and never required** — the resource is handed
over either way. That is the only arrangement in which a tick means anything.
The exact sentence shown is stored on the lead along with the timestamp, so the
record can always say what was agreed to and when.

Leads that qualify arrive in Harvey as prospects with
`email_status = "verified"`, `source = "resource:<slug>"`, and a note saying
which resource they took. Worth being precise about that label: the address was
typed by its owner to receive something they wanted and a message to it was
accepted for delivery. That is stronger than the pattern-guessed addresses
Harvey normally works with and weaker than a mailbox probe. If one is wrong,
Harvey's own bounce handling catches it and `max_bounce_rate` pauses sending.

**Not yet wired:** Resend's bounce webhook. Today a send that Resend accepts and
the recipient's server later rejects still counts as delivered here. Harvey
catches it downstream, but flipping the lead to failed on a bounce would catch
it sooner.

### Previewing the pages locally

There is no local database by default. To see the public pages on this machine:

```bash
/opt/homebrew/opt/postgresql@16/bin/initdb -D /tmp/orpg -U postgres --auth=trust --locale=C
/opt/homebrew/opt/postgresql@16/bin/pg_ctl -D /tmp/orpg -o "-p 5433" -l /tmp/orpg/server.log start
/opt/homebrew/opt/postgresql@16/bin/createdb -h 127.0.0.1 -p 5433 -U postgres openreply
printf 'DATABASE_URL="postgresql://postgres@127.0.0.1:5433/openreply"\nNEXTAUTH_URL="http://localhost:3000"\nNEXTAUTH_SECRET="local-only"\n' > .env.local
npx prisma migrate deploy && npm run dev
```

Then insert a workspace with a `publicSlug` and a published `Resource`, and open
`/resources/<slug>`. Stop and delete the cluster with `pg_ctl -D /tmp/orpg stop`
and `rm -rf /tmp/orpg`.
