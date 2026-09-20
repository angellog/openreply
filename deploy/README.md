# Running OpenReply on a VPS

The upstream guide assumes Vercel for the web app and Railway for the worker,
Postgres, and Redis. This runs all four on one box you control.

Everything here targets **Ubuntu 22.04 or 24.04**. No Docker.

## What you need

- A VPS with **2 GB RAM minimum**. The build is the constraint, not the running
  app — `next build` will be OOM-killed on 1 GB. `provision.sh` adds a 2 GB
  swapfile on anything under 4 GB, which makes 2 GB workable. 4 GB is
  comfortable. One vCPU is fine.
- **A domain.** Not optional. Meta refuses to deliver webhooks to an endpoint
  without a publicly-trusted certificate, and Let's Encrypt does not issue
  certificates for bare IP addresses. Point an A record at the VPS.
- Root or sudo over SSH.

## Install

```bash
sudo apt-get update && sudo apt-get install -y git
sudo git clone https://github.com/diwenne/openreply.git /srv/openreply
sudo /srv/openreply/deploy/provision.sh
```

`provision.sh` is idempotent — re-run it after changing `deploy.conf`, or when a
step failed partway. It installs Node, Postgres, Redis, and Caddy; creates the
`openreply` user, database, and environment file with freshly generated secrets;
installs ten systemd units; closes the firewall to everything but SSH and
HTTP(S); and runs the first build.

It finishes by printing your Setup Console URL, including its token. That token
is the only thing standing between the internet and a UI that can rewrite your
configuration — treat it like a password.

Set the real hostname once DNS is ready:

```bash
sudo /srv/openreply/deploy/set-domain.sh openreply.yourdomain.com
```

That updates Caddy, `NEXTAUTH_URL`, and the sender address together, then prints
the two URLs to paste into your Meta app.

## What is running

| Unit | What it does |
| --- | --- |
| `openreply-web` | Next.js on `127.0.0.1:3000`. Serves the dashboard and receives Meta's webhooks. |
| `openreply-worker` | Consumes the BullMQ queue and sends the DMs. **Without this, nothing is ever delivered.** |
| `openreply-refresh-tokens.timer` | Daily. Renews Instagram tokens before they expire. |
| `openreply-attach-next-reel.timer` | Every 15 minutes. Binds "next reel" targets to a published reel. |
| `openreply-backup.timer` | Nightly `pg_dump`, 14 days retained. |
| `openreply-healthcheck.timer` | Every 5 minutes. Restarts a wedged web app or worker. |
| `caddy` | TLS termination and reverse proxy. Renews the certificate itself. |
| `postgresql`, `redis-server` | Loopback only. Never exposed. |

All of them are `WantedBy=multi-user.target` or `timers.target`, so the whole
stack comes back on reboot without you touching it.

## The crons matter more than they look

`vercel.json` schedules two jobs. Nothing reads that file on a VPS, so systemd
timers call the same endpoints through `/usr/local/bin/openreply-cron`.

**`refresh-tokens` is the one that decides whether this is still working in three
months.** Instagram access tokens expire roughly 60 days after they are issued.
The job renews any token within 10 days of expiring. If it silently stops, there
is no error and no alert — DMs simply stop going out about two months later, and
the cause is a long way from the symptom. The timer is `Persistent=true` so a run
missed while the box was down fires on the next boot rather than being skipped.

`attach-next-reel` gets a genuine upgrade here. Instagram sends no webhook when
media is published, so it polls, and Vercel's free plan caps a cron at once per
day — meaning a "next reel" target could sit idle for 24 hours after you posted.
A VPS has no such cap, so it runs every 15 minutes.

Check they are firing:

```bash
systemctl list-timers 'openreply-*'
journalctl -u openreply-refresh-tokens --since '7 days ago'
```

Run one by hand:

```bash
sudo /usr/local/bin/openreply-cron refresh-tokens
```

## Deploying an update

```bash
sudo -u openreply /srv/openreply/deploy/deploy.sh
```

Pulls, installs, migrates, builds, then restarts. The build runs *before*
anything is restarted, so a broken build leaves the running version serving.

The service user is granted exactly two `systemctl restart` commands through
`/etc/sudoers.d/openreply` and nothing else, so a deploy never needs full root.

**Restarts do not lose comments.** There is a gap of a few seconds where webhook
deliveries can be missed, but Meta retries, and the worker's polling reconciler
sweeps for anything both paths missed. That reconciler is why brief downtime is
safe here.

## Logs

```bash
journalctl -u openreply-web -f
journalctl -u openreply-worker -f
journalctl -u caddy -f
journalctl -u openreply-healthcheck --since today
```

The app's own `/diagnostics` page shows queue depth, worker heartbeat, failed
sends, and webhook signature failures — usually more useful than the journal
when the question is "why did this comment not get a DM".

## Configuration

`/etc/openreply/openreply.env` is the single source of truth. It is `0640`,
owned `root:openreply`, and loaded by systemd for both services. Values here
beat any `.env` in the checkout, because `dotenv` never overwrites a variable
that is already set.

Edit it through the Setup Console at `https://your.domain/setup?token=…`, or by
hand. Either way, restart afterwards — connection strings, secrets, and the
webhook verify token are all read once at boot:

```bash
sudo systemctl restart openreply-web openreply-worker
```

To close the Setup Console entirely, set `SETUP_CONSOLE_ENABLED=false` and
restart. Everything it does can also be done by editing the env file over SSH.

## Backups

Nightly to `/var/backups/openreply`, 14 days retained, `0600`.

The dumps are **useless without `ENCRYPTION_KEY`** — Instagram tokens are
encrypted with it, so restoring onto an instance with a different key leaves
every connected account unable to send. The backup writes a copy of the env file
alongside the dump for exactly that reason.

A backup that only exists on the machine it is backing up is not a backup. Pull
it somewhere else on a schedule, from your own machine:

```bash
rsync -az --delete root@your-vps:/var/backups/openreply/ ~/backups/openreply/
```

Restore:

```bash
sudo systemctl stop openreply-web openreply-worker
gunzip -c /var/backups/openreply/openreply-<stamp>.sql.gz \
  | sudo -u postgres psql openreply
sudo systemctl start openreply-web openreply-worker
```

## Sizing and cost

A single Instagram account nowhere near Meta's cap of 750 private replies per
hour runs comfortably on the smallest 2 GB tier at most providers — roughly
$6–12/month, plus the domain. Postgres and Redis on the same box is the right
call at this scale; the queue is small and the database is mostly append-only
logs.

Watch disk if DM volume is high: `DmLog` and `LinkClick` grow without bound and
are the only tables that will.

## Health and failure modes

| Symptom | Cause | Fix |
| --- | --- | --- |
| Comments arrive, no DMs sent | Worker down | `systemctl status openreply-worker` |
| No comments arrive at all | Webhook not subscribed, or certificate lapsed | Setup Console → Overview; `journalctl -u caddy` |
| DMs stopped ~2 months in | `refresh-tokens` not running | `systemctl list-timers 'openreply-*'` |
| Webhook 401s in `/diagnostics` | `FACEBOOK_APP_SECRET` is the Instagram secret | They are different values — Setup Console → Meta tab |
| Build killed during deploy | Out of memory | Confirm the swapfile: `swapon --show` |

The healthcheck timer restarts a web app that has stopped answering HTTP, and a
worker whose Redis heartbeat has gone stale. It deliberately does **not** restart
the web app on a `503` — `/api/health` returns 503 whenever the worker is down,
and restarting the wrong service would mask the real fault.

## Hardening notes

- Postgres and Redis bind to loopback only; `ufw` allows just 22, 80, and 443.
- Redis is set to `maxmemory-policy noeviction`. BullMQ requires this — under
  any eviction policy Redis can silently discard queue keys under memory
  pressure, losing queued DMs with no error anywhere.
- Both services run as an unprivileged system user under `ProtectSystem=strict`,
  `PrivateTmp`, and `NoNewPrivileges`.
- Unattended security upgrades are enabled.
- Consider disabling SSH password authentication if you have not already.
