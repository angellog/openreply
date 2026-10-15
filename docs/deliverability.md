# Sending domains, SPF, DKIM and DMARC

The single thing standing between this stack and results. The software is
finished; whether the email arrives is a DNS and reputation question.

---

## The problem in one paragraph

A receiving mail server has about a second to decide whether your message is
wanted. It cannot read it, so it judges the **domain it came from**: has this
domain sent mail before, did people complain, do its DNS records say this
server was allowed to send on its behalf. A brand-new domain sending fifty
cold emails on day one looks exactly like a spammer, because that is what a
spammer does.

Three DNS records answer the "was this allowed" half. Reputation answers the
rest, and reputation is earned slowly and lost instantly.

## What the three records actually do

| Record | What it says | What happens without it |
|---|---|---|
| **SPF** | "These servers may send mail as `@yourdomain`." A TXT record listing them. | Receivers cannot tell your sender from a forger. Gmail marks it suspicious; some reject outright. |
| **DKIM** | "This message carries a signature only the real owner could have made." A public key in DNS; your provider holds the private key. | No cryptographic proof. Anyone can forge your address, and your real mail is treated as unproven. |
| **DMARC** | "If SPF and DKIM both fail, do this — and send me a report." | Receivers each guess differently. You also get no visibility: you never learn who is forging you or which mail is failing. |

SPF and DKIM are permissions. DMARC is the policy that ties them together and
the only one that reports back.

## Why a *separate* domain, not your main one

This is the part people skip and regret.

Reputation attaches to the domain. If cold outreach from `feetbit.com` earns
spam complaints, the damage lands on **everything** `feetbit.com` sends:
order confirmations, delivery updates, replies to customers who asked you a
question. You find out when a customer says "I never got my receipt", and by
then it has been happening for weeks.

So: outreach goes out from a domain that is **not** the one your customers
already rely on.

```
feetbit.com          <- customer receipts, replies. Never used for outreach.
getfeetbit.com       <- cold outreach only. If it burns, nothing else breaks.
```

A lookalike domain is normal practice, not a trick. It should be obviously
yours — your brand plus a word, or a different TLD. Not a misspelling, which
reads as phishing to both humans and filters.

A **subdomain** (`mail.feetbit.com`) is the weaker middle option. It gets some
separation, but it shares the root domain's reputation, so serious damage still
reaches the parent. Use it only if buying a second domain is genuinely not an
option.

---

## Where you actually stand

Checked by DNS lookup, 2026-10-15:

| Domain | State | What it means |
|---|---|---|
| `vantik.io` | Live on Cloudflare, **no MX** | Yours, actively managed, no mail configured yet |
| `vantik.co` | Registrar default nameservers | Possibly yours. If so, this is Vantik's sending domain |
| `equatoradvisory.com` | Parked on a lander page | Not set up |
| `feetbit.com` | Parked for sale (Afternic) | **Not yours.** Someone is selling it |
| `feetbit.ug`, `feetbit.co.ug`, `legitsneakers.ug`, `feetbitsneakers.com` | Unregistered | Available |

So the two brands are in different situations, and need different moves.

### Vantik — closest to ready
`vantik.io` is on Cloudflare with no mail at all, which makes this easy. If
`vantik.co` is yours, use it as the sending domain and leave `vantik.io` for
the brand. If it is not, buy one domain for sending.

### FeetBit — no domain at all
There is nothing to configure yet. FeetBit needs a domain regardless of cold
email: the WhatsApp-first setup works, but a sneaker business with no domain
has no email identity to build on. `feetbit.com` is for sale and will be priced
as a premium name; the `.ug` variants are unregistered and cheap.

---

## The fix, start to finish

Roughly 45 minutes of work, then two weeks of patience.

### 1. Get the domain
Any registrar. Cloudflare sells at cost and you are already using it for
`vantik.io`. Expect $10-15/year for a `.com`, less for `.ug`.

### 2. Put a mailbox on it
Harvey sends through a real mailbox, not a bulk API, because a real mailbox is
what a reply comes back to. Two options:

- **Google Workspace**, about $7/user/month. Harvey's `gmail` provider talks to
  it directly. Easiest, best deliverability, and you get a real inbox.
- **Any SMTP/IMAP mailbox** (Fastmail, Zoho, your registrar's mail). Harvey's
  `smtp` provider works with these. Cheaper, slightly more setup.

Set `channels.email.provider` in `harvey.yaml` to whichever you pick.

### 3. Add the three records
Your provider gives you the exact values during setup. The shapes:

```
Type   Name              Value
TXT    @                 v=spf1 include:_spf.google.com ~all
TXT    google._domainkey v=DKIM1; k=rsa; p=<long key your provider gives you>
TXT    _dmarc            v=DMARC1; p=none; rua=mailto:you@yourdomain.com
```

Start DMARC at `p=none`. That means "watch and report, change nothing", so a
misconfiguration cannot silently bin your own mail. Read the reports for a
couple of weeks, then tighten to `p=quarantine` once everything passes.

On Cloudflare: DNS → Records → Add record. Set these to **DNS only** (grey
cloud), not proxied.

### 4. Verify before sending anything
```bash
dig +short TXT yourdomain.com | grep spf
dig +short TXT google._domainkey.yourdomain.com
dig +short TXT _dmarc.yourdomain.com
```
All three must return something. Then send one email to a Gmail account you
own, open it, and use "Show original": SPF, DKIM and DMARC must all say PASS.

### 5. Warm up, which is the part that cannot be rushed
A new domain sending 50 cold emails on day one gets filtered, and the
reputation hit is hard to undo.

| Period | Volume/day | Also do this |
|---|---|---|
| Week 1 | 5-10 | Send to people who will actually reply. Reply to their replies. |
| Week 2 | 10-20 | Watch for bounces. Any bounce, stop and check the address source. |
| Weeks 3-4 | 20-35 | Keep bounce rate under 2%. |
| After | up to 50 | Harvey's `max_daily_sends` cap. A ceiling, not a target. |

Set `channels.email.max_daily_sends` to match the week you are in. Harvey's
own bounce protection pauses sending above `max_bounce_rate` (default 5%),
which is a backstop, not a plan.

---

## What this buys you

**Without it:** mail from a cold domain with no records lands in spam at a high
rate. You will not know, because spam placement is invisible from the sending
side — no bounce, no error, just silence. You conclude the offer is wrong when
the real problem was DNS.

**With it:** the inbox is reachable, and a non-reply means the offer was not
interesting, which is information you can act on.

**And critically:** when it does go wrong, it goes wrong on a domain whose only
job is outreach. Your customers keep getting their receipts.

---

## Rules that protect reputation more than any record

- **One no is enough.** Harvey closes a prospect who declines. Leave that alone.
- **Honour unsubscribes instantly.** Harvey handles the keyword itself.
- **Never buy a list.** Bought addresses contain spam traps, and one trap hit
  can blacklist a domain for months.
- **Addresses come from people who gave them to you** (the resource hub) or
  from businesses whose address is published for enquiries. Nothing else.
- **A bounce is a signal, not noise.** A rising bounce rate means the address
  source is bad; fix the source, do not push through it.

You are the sender. CAN-SPAM, GDPR and the Uganda Data Protection and Privacy
Act apply to you, not to Harvey. A real physical address and a working
unsubscribe in commercial email is the legal floor in most jurisdictions.
