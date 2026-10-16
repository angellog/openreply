/**
 * The systems registry.
 *
 * This fork runs five systems inside one Next.js app. One came with the
 * open-source project; four were fused in afterwards. Until now the only trace
 * of that was ten links in a flat sidebar, which told an operator nothing
 * useful: not which machine a page talks to, not whether that machine is
 * awake, and not what has to be true before the page does anything at all.
 *
 * Everything the UI says about a system is derived from this file — the grouped
 * navigation, the systems map, the per-page banner and the guide. One registry,
 * several views, so a system cannot be added to the product and forgotten in
 * the documentation. The test suite enforces that: every page listed here must
 * exist on disk, and every system must have setup steps and a status probe.
 */

export const SYSTEM_IDS = [
  "instagram",
  "whatsapp",
  "harvey",
  "resources",
  "platform",
] as const;

export type SystemId = (typeof SYSTEM_IDS)[number];

/** Where a system's code actually executes. */
export type Runtime =
  /** A Vercel serverless function, i.e. the Next.js app itself. */
  | "vercel"
  /** A long-lived process: the Railway DM worker, or the OpenWA container. */
  | "worker"
  /** The operator's own Mac. Only Harvey. */
  | "local";

export interface SystemPage {
  href: string;
  label: string;
  /** One line, in the second person: what the operator does here. */
  purpose: string;
  /** The page an operator should open first when working on this system. */
  isPrimary?: boolean;
  /** Shown in the guide but not in the sidebar (a detail or sub-page). */
  hiddenInNav?: boolean;
}

export interface SetupStep {
  title: string;
  /** What to do. Plain prose, no markdown. */
  detail: string;
  /** A page in this app where the step is carried out, when there is one. */
  href?: string;
  /** Something only the operator can do — buy a domain, scan a QR, sign in. */
  manual?: boolean;
}

export interface SystemDefinition {
  id: SystemId;
  name: string;
  /** One sentence an operator would recognise as the job this system does. */
  tagline: string;
  /** Did this come with the fork, or was it fused in here. */
  origin: "forked" | "fused";
  runtime: {
    kind: Runtime;
    /** Human label for the machine, e.g. "Your Mac". */
    label: string;
    /** Why it runs there, when that is not obvious. */
    detail: string;
  };
  /** Without these, the system cannot work at all. Names only, never values. */
  requiredEnv: string[];
  pages: SystemPage[];
  /**
   * Where this system lives in the codebase. This is the answer to "show me
   * where the system was dissolved": Prisma models it owns, API routes it
   * serves, and the library folders holding its logic.
   */
  owns: {
    models: string[];
    routes: string[];
    libs: string[];
  };
  setup: SetupStep[];
  /** What this system genuinely cannot do. Stated so nobody waits for it. */
  limits: string[];
}

export const SYSTEMS: Record<SystemId, SystemDefinition> = {
  instagram: {
    id: "instagram",
    name: "Instagram DM",
    tagline:
      "Someone comments on a post, and a DM with your link goes out within seconds.",
    origin: "forked",
    runtime: {
      kind: "worker",
      label: "Vercel + Railway worker",
      detail:
        "Meta's webhook hits a Vercel route, which queues the DM on Redis. A long-lived Railway worker sends it, because Meta's rate limits need a process that remembers what it sent a minute ago.",
    },
    requiredEnv: [
      "INSTAGRAM_APP_ID",
      "INSTAGRAM_APP_SECRET",
      "FACEBOOK_APP_SECRET",
      "WEBHOOK_VERIFY_TOKEN",
      "REDIS_URL",
    ],
    pages: [
      {
        href: "/dashboard",
        label: "Dashboard",
        purpose: "See today's sends, click-through rate and the last ten DMs.",
        isPrimary: true,
      },
      {
        href: "/overview",
        label: "Account health",
        purpose:
          "Check each connected account's token, webhook subscription and follower trend.",
      },
      {
        href: "/campaigns",
        label: "Campaigns",
        purpose:
          "Build the rules: which post, which keyword, which reply, which link.",
      },
      {
        href: "/inbox",
        label: "Inbox",
        purpose: "Read and answer the DM threads your automations started.",
      },
      {
        href: "/logs",
        label: "DM log",
        purpose:
          "Every send attempt with its outcome — sent, skipped or failed, and why.",
      },
      {
        href: "/campaigns/new",
        label: "New campaign",
        purpose:
          "Pick the post, the keyword, the reply and the link, in one pass.",
        hiddenInNav: true,
      },
      {
        href: "/campaigns/import",
        label: "Import campaigns",
        purpose: "Bulk-create campaigns from a CSV.",
        hiddenInNav: true,
      },
    ],
    owns: {
      models: [
        "InstagramAccount",
        "Automation",
        "DmLog",
        "WebhookEvent",
        "TrackedLink",
        "LinkClick",
        "FollowerSnapshot",
      ],
      routes: [
        "/api/webhook",
        "/api/instagram/*",
        "/api/automations",
        "/api/dashboard/stats",
        "/api/logs",
        "/r/[slug]",
      ],
      libs: ["lib/meta", "lib/queue", "lib/tracking", "worker/dm-worker.ts"],
    },
    setup: [
      {
        title: "Connect an Instagram account",
        detail:
          "Use the Connect button in the top bar. It needs a Professional account attached to a Facebook Page — a personal account cannot receive the DM permission.",
        href: "/overview",
      },
      {
        title: "Confirm the webhook subscribed",
        detail:
          "Account health shows a webhook column per account. Without it Meta never tells us about new comments, and nothing fires.",
        href: "/overview",
      },
      {
        title: "Build one campaign",
        detail:
          "Pick a post, give it a keyword, write the DM and attach a tracked link. Keep the first one narrow so you can tell whether it worked.",
        href: "/campaigns/new",
      },
      {
        title: "Comment on your own post to test it",
        detail:
          "Use the keyword from a different account. The DM log shows the attempt either way, which is what makes this a real test rather than a hope.",
        href: "/logs",
        manual: true,
      },
    ],
    limits: [
      "Meta only delivers comment webhooks for Professional accounts on a Page. There is no workaround.",
      "A DM can only be sent within 24 hours of the person's comment; Meta closes the window after that.",
      "If the Railway worker is down, DMs queue rather than send. The queue survives, the timing does not.",
    ],
  },

  whatsapp: {
    id: "whatsapp",
    name: "WhatsApp",
    tagline:
      "The link in a DM or an email opens a WhatsApp chat, and the chat lands here attributed to the campaign that caused it.",
    origin: "fused",
    runtime: {
      kind: "worker",
      label: "OpenWA container",
      detail:
        "A self-hosted OpenWA service holds the WhatsApp Web session for each number. This app never touches WhatsApp directly: it asks OpenWA, and OpenWA posts inbound messages back to a webhook here.",
    },
    requiredEnv: ["OPENWA_BASE_URL", "OPENWA_API_KEY"],
    pages: [
      {
        href: "/whatsapp",
        label: "Numbers & leads",
        purpose:
          "Connect a number by QR, watch it stay connected, and read the leads that arrived.",
        isPrimary: true,
      },
    ],
    owns: {
      models: ["WhatsAppLead", "WhatsAppMessage"],
      routes: [
        "/api/whatsapp/sessions",
        "/api/whatsapp/sessions/[id]/qr",
        "/api/whatsapp/sessions/[id]/start",
        "/api/whatsapp/webhook",
        "/api/whatsapp/leads",
        "/api/whatsapp/funnel",
      ],
      libs: ["lib/whatsapp"],
    },
    setup: [
      {
        title: "Run an OpenWA service and point this app at it",
        detail:
          "Set OPENWA_BASE_URL and OPENWA_API_KEY. Until both are set this page says it is not configured and does nothing else.",
        manual: true,
      },
      {
        title: "Add a number and scan the QR",
        detail:
          "The QR is a WhatsApp Web login. Scan it from the phone that owns the number. The session stays alive until WhatsApp logs it out, which it eventually will.",
        href: "/whatsapp",
        manual: true,
      },
      {
        title: "Set the handoff on each campaign or agent",
        detail:
          "A tracked link needs to know which number to open and what to pre-fill. Instagram campaigns set it per campaign; Harvey sets it once per agent.",
        href: "/campaigns",
      },
    ],
    limits: [
      "This is WhatsApp Web, not the Business API. WhatsApp can log the session out at any time, and you reconnect by scanning again.",
      "Attribution depends on the ref marker surviving in the customer's first message. If they clear the pre-filled text, the chat still arrives but unattributed.",
    ],
  },

  harvey: {
    id: "harvey",
    name: "Harvey",
    tagline:
      "An autonomous agent on your own Mac finds companies, writes cold email, and waits for you to approve each one from your phone.",
    origin: "fused",
    runtime: {
      kind: "local",
      label: "Your Mac",
      detail:
        "Harvey's model backend is your logged-in Claude Code CLI, whose credentials live in the macOS Keychain. That is why it cannot be deployed: there is no API bill, and no way to carry that session to a server. Harvey pushes to this app and polls it; nothing listens on your Mac.",
    },
    requiredEnv: [],
    pages: [
      {
        href: "/outreach",
        label: "Approvals",
        purpose:
          "Read each drafted email and approve or reject it. Nothing is sent until you do.",
        isPrimary: true,
      },
    ],
    owns: {
      models: [
        "HarveyAgent",
        "HarveyCompany",
        "HarveyProspect",
        "HarveyEmail",
        "HarveyCommand",
        "OutreachEvent",
      ],
      routes: [
        "/api/harvey/v1/sync",
        "/api/harvey/v1/links",
        "/api/outreach/agents",
        "/api/outreach/outbox",
        "/api/outreach/brand",
      ],
      libs: ["lib/harvey", "lib/outreach"],
    },
    setup: [
      {
        title: "Create an agent here",
        detail:
          "One agent per brand. Creating it shows a secret exactly once — that pair of values is how your Mac proves it is yours.",
        href: "/outreach",
      },
      {
        title: "Put the two values in Harvey's .env",
        detail:
          "The file is ~/Projects/harvey/.env, which is gitignored. Add OPENREPLY_AGENT_ID and OPENREPLY_AGENT_SECRET, then set openreply.enabled and base_url in harvey.yaml.",
        manual: true,
      },
      {
        title: "Set the agent's handoff",
        detail:
          "Until a WhatsApp number or a destination URL is set on the agent, Harvey cannot mint a tracked link, so its emails have nothing to click.",
        href: "/outreach",
      },
      {
        title: "Start Harvey and watch it check in",
        detail:
          "Run harvey run on your Mac. Within a heartbeat the agent card here goes from offline to online, and drafts begin arriving.",
        manual: true,
      },
    ],
    limits: [
      "Harvey only works while your Mac is awake. A sleeping laptop looks exactly like a crashed one, which is why the agent card shows when it last checked in.",
      "Approving from your phone queues a decision; Harvey acts on it at its next heartbeat, not instantly.",
      "Without a dedicated sending domain with SPF, DKIM and DMARC, cold email lands in spam regardless of how good the writing is.",
      "A send accepted by the mail provider and bounced afterwards still counts as delivered here. The bounce webhook is not wired up yet.",
    ],
  },

  resources: {
    id: "resources",
    name: "Resource hub",
    tagline:
      "A public page of your resources behind an email wall. Giving an address is how a stranger becomes a lead Harvey may write to.",
    origin: "fused",
    runtime: {
      kind: "vercel",
      label: "Vercel",
      detail:
        "Entirely serverless: a public page, a claim route, and one transactional email carrying the link. The files themselves stay wherever they already live, usually Drive.",
    },
    // Mail is either-or: your own SMTP server, or Resend. Listing both as
    // required would report a problem on a deployment that is fine, so the
    // status probe asks lib/email's own isEmailConfigured() instead.
    requiredEnv: [],
    pages: [
      {
        href: "/outreach/resources",
        label: "Resources & leads",
        purpose:
          "Publish resources, set the brand slug for the public URL, and read who claimed what.",
        isPrimary: true,
      },
    ],
    owns: {
      models: ["Resource", "ResourceLead", "Workspace.publicSlug"],
      routes: [
        "/api/outreach/resources",
        "/api/resources/[brand]/[slug]/claim",
        "/resources/[brand]",
        "/resources/[brand]/[slug]",
      ],
      libs: ["lib/resources", "lib/email"],
    },
    setup: [
      {
        title: "Choose the public brand slug",
        detail:
          "This becomes /resources/<slug>. It is the one piece of the URL you cannot change quietly later, because you will have shared it.",
        href: "/outreach/resources",
      },
      {
        title: "Add a resource and publish it",
        detail:
          "Title, one-line reason to hand over an address, and the destination link. Everything starts unpublished so a half-written gate is never live.",
        href: "/outreach/resources",
      },
      {
        title: "Make sure mail can be sent",
        detail:
          "Set either EMAIL_SERVER for your own SMTP, or RESEND_API_KEY. It is the same transport magic-link sign-in uses, so a deployment that can sign you in can already deliver a resource.",
        manual: true,
      },
      {
        title: "Check the delivery email actually arrives",
        detail:
          "Claim your own resource with a real address. The page shows the link either way, but a bounce is the only thing that proves an address is junk.",
        href: "/outreach/resources",
        manual: true,
      },
    ],
    limits: [
      "This is a soft gate. The destination link is handed over after one email address, and a link that leaks is a link that works.",
      "Only a lead who ticked the consent box, received the email, and has not been exported already is ever offered to Harvey.",
    ],
  },

  platform: {
    id: "platform",
    name: "Platform",
    tagline:
      "The parts every system leans on: the workspace, the people in it, and the health of the machinery.",
    origin: "forked",
    runtime: {
      kind: "vercel",
      label: "Vercel + Postgres",
      detail:
        "One Postgres database serves all five systems. That is deliberate: attribution from a cold email click through to a WhatsApp lead is a join, and splitting the database would break the one thing this fusion is for.",
    },
    requiredEnv: [
      "DATABASE_URL",
      "NEXTAUTH_SECRET",
      "NEXTAUTH_URL",
      "ENCRYPTION_KEY",
    ],
    pages: [
      {
        href: "/systems",
        label: "Systems map",
        purpose:
          "Every system, whether it is running, and what flows between them.",
        isPrimary: true,
      },
      {
        href: "/guide",
        label: "Guide",
        purpose: "What works where, when and how — start here if you are stuck.",
      },
      {
        href: "/settings",
        label: "Settings",
        purpose: "Workspace name, members and invitations.",
      },
      {
        href: "/diagnostics",
        label: "Diagnostics",
        purpose:
          "Queue depth, worker heartbeat, failed webhooks and unresolved errors.",
      },
    ],
    owns: {
      models: [
        "Workspace",
        "WorkspaceMember",
        "WorkspaceInvitation",
        "User",
        "OperationalEvent",
      ],
      routes: [
        "/api/systems/status",
        "/api/admin/diagnostics",
        "/api/workspace/*",
        "/api/health",
        "/api/auth/*",
      ],
      libs: ["lib/systems", "lib/ops", "lib/db", "lib/auth.ts"],
    },
    setup: [
      {
        title: "Invite whoever else needs to approve things",
        detail:
          "Members share the workspace and therefore the approvals desk. Harvey's secrets are never retrievable, so a member cannot walk off with them.",
        href: "/settings",
      },
      {
        title: "Look at diagnostics once while things work",
        detail:
          "Knowing what a healthy queue depth and heartbeat look like is what makes an unhealthy one obvious later.",
        href: "/diagnostics",
      },
    ],
    limits: [
      "All five systems share one Next.js app and one database. A bad migration is a bad migration for everything.",
      "Vercel functions are short-lived, so nothing here can hold a WhatsApp session or run an agent loop. That is why two systems live on other machines.",
    ],
  },
};

/** Declaration order is navigation order. */
export const SYSTEM_ORDER: SystemId[] = [
  "instagram",
  "whatsapp",
  "harvey",
  "resources",
  "platform",
];

export function listSystems(): SystemDefinition[] {
  return SYSTEM_ORDER.map((id) => SYSTEMS[id]);
}

/**
 * The data that moves between systems. This is the half of the architecture
 * that the file layout cannot show: four systems that each look independent,
 * joined by five specific hand-offs.
 */
export interface SystemFlow {
  from: SystemId;
  to: SystemId;
  label: string;
  /** How it travels, named concretely enough to grep for. */
  mechanism: string;
}

export const SYSTEM_FLOWS: SystemFlow[] = [
  {
    from: "instagram",
    to: "whatsapp",
    label: "Comment becomes a WhatsApp chat",
    mechanism:
      "The DM carries /r/<slug>, which redirects to wa.me with a ref marker. The inbound webhook reads the marker back.",
  },
  {
    from: "harvey",
    to: "whatsapp",
    label: "Cold email becomes a WhatsApp chat",
    mechanism:
      "Harvey mints a tracked link through /api/harvey/v1/links. The destination comes from the agent's own handoff, never from the request.",
  },
  {
    from: "resources",
    to: "harvey",
    label: "Claimed resource becomes a prospect",
    mechanism:
      "A lead with consentMarketing true, a delivered email and no exportedAt is handed to Harvey once, on its next sync.",
  },
  {
    from: "whatsapp",
    to: "harvey",
    label: "Engagement teaches the agent",
    mechanism:
      "Clicks, chats and replies become OutreachEvent rows, which Harvey collects and turns into observations against governed signal codes.",
  },
  {
    from: "harvey",
    to: "platform",
    label: "Approvals and errors surface centrally",
    mechanism:
      "Decisions become HarveyCommand rows collected on the next heartbeat; auth failures become OperationalEvent rows on the diagnostics page.",
  },
];

/** The system a given pathname belongs to, for the page banner and help link. */
export function systemForPath(pathname: string): SystemDefinition | null {
  let best: { system: SystemDefinition; length: number } | null = null;
  for (const system of listSystems()) {
    for (const page of system.pages) {
      const matches =
        pathname === page.href || pathname.startsWith(page.href + "/");
      if (matches && (!best || page.href.length > best.length)) {
        best = { system, length: page.href.length };
      }
    }
  }
  return best?.system ?? null;
}
