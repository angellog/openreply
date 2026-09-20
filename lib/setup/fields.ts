/**
 * The single source of truth for every environment variable the Setup Console
 * knows how to show, validate, generate, and write.
 *
 * `lib/env.ts` owns the runtime contract (what the app throws on at boot). This
 * file owns the *authoring* contract: what a human needs to be told in order to
 * fill each value in correctly. They have to agree on which variables are
 * required, so `__tests__/setup-fields.test.ts` asserts that every key in
 * `serverEnvSchema` is a required field here.
 */

export type FieldKind = "text" | "secret" | "url" | "email" | "select";

export type FieldGroup = "app" | "data" | "email" | "meta" | "tuning";

export type GeneratorKind = "base64_32" | "hex_32" | "hex_16";

export interface EnvField {
  name: string;
  label: string;
  group: FieldGroup;
  kind: FieldKind;
  /** Required means the app cannot boot or cannot sign anyone in without it. */
  required: boolean;
  help: string;
  placeholder?: string;
  options?: readonly string[];
  /** Offer a "generate" button that mints a correctly-shaped random value. */
  generator?: GeneratorKind;
  /** Where the value comes from, when it is not something you invent. */
  source?: string;
}

export interface FieldGroupSpec {
  id: FieldGroup;
  title: string;
  description: string;
}

export const FIELD_GROUPS: readonly FieldGroupSpec[] = [
  {
    id: "app",
    title: "App",
    description:
      "Your public URL and the secrets that sign sessions and encrypt Instagram tokens.",
  },
  {
    id: "data",
    title: "Database and queue",
    description:
      "Postgres holds campaigns and logs. Redis backs the send queue and the per-account rate limiter.",
  },
  {
    id: "email",
    title: "Login email",
    description:
      "Sign-in is email magic links only. Without a working Resend key nobody can sign in through the normal flow.",
  },
  {
    id: "meta",
    title: "Meta and Instagram",
    description:
      "Credentials from your Meta app. These are the slow part of setup — the Meta tab walks you through them.",
  },
  {
    id: "tuning",
    title: "Polling reconciler",
    description:
      "Optional. The worker sweeps for comments the webhook missed. The defaults are deliberately conservative.",
  },
] as const;

const HEX_64 = /^[a-f0-9]{64}$/i;

export const ENV_FIELDS: readonly EnvField[] = [
  {
    name: "NEXTAUTH_URL",
    label: "Public URL",
    group: "app",
    kind: "url",
    required: true,
    help: "The URL this instance is reachable at. Meta posts webhooks here and tracked links are built from it. Locally this is http://localhost:3000, but Meta cannot reach localhost — use a tunnel URL when you wire up webhooks.",
    placeholder: "http://localhost:3000",
  },
  {
    name: "NEXTAUTH_SECRET",
    label: "Auth secret",
    group: "app",
    kind: "secret",
    required: true,
    help: "Signs session cookies and the Instagram OAuth state parameter. Any long random string.",
    generator: "base64_32",
    source: "openssl rand -base64 32",
  },
  {
    name: "ENCRYPTION_KEY",
    label: "Token encryption key",
    group: "app",
    kind: "secret",
    required: true,
    help: "Exactly 64 hex characters. Encrypts stored Instagram access tokens with AES-256-GCM. The web app and the worker must use the identical value, or every send fails to decrypt.",
    generator: "hex_32",
    source: "openssl rand -hex 32",
  },
  {
    name: "CRON_SECRET",
    label: "Cron secret",
    group: "app",
    kind: "secret",
    required: false,
    help: "Protects the token-refresh cron endpoint from being called by anyone else.",
    generator: "base64_32",
    source: "openssl rand -base64 32",
  },
  {
    name: "DATABASE_URL",
    label: "PostgreSQL URL",
    group: "data",
    kind: "text",
    required: true,
    help: "Postgres connection string. In production give Vercel the public Railway URL, never the *.railway.internal one — Vercel sits outside Railway's private network and will hang on it.",
    placeholder: "postgresql://postgres:postgres@localhost:5432/openreply",
  },
  {
    name: "REDIS_URL",
    label: "Redis URL",
    group: "data",
    kind: "text",
    required: true,
    help: "Redis connection string. BullMQ needs blocking commands, so an HTTP-only Redis (Upstash REST, for example) will not work.",
    placeholder: "redis://localhost:6379",
  },
  {
    name: "RESEND_API_KEY",
    label: "Resend API key",
    group: "email",
    kind: "secret",
    required: false,
    help: "Sends the login magic links. Optional for local work — the Setup Console can mint a local session without it — but required before anyone else can sign in.",
    placeholder: "re_...",
    source: "resend.com/api-keys",
  },
  {
    name: "EMAIL_FROM",
    label: "Sender address",
    group: "email",
    kind: "text",
    required: false,
    help: "A sender on a domain you verified in Resend. The placeholder example.com address will not deliver.",
    placeholder: "OpenReply <login@yourdomain.com>",
  },
  {
    name: "META_GRAPH_API_VERSION",
    label: "Graph API version",
    group: "meta",
    kind: "select",
    required: false,
    help: "Which Graph API version to call. Leave this alone unless you have a reason.",
    options: ["v25.0", "v24.0", "v23.0", "v22.0", "v21.0"],
    placeholder: "v25.0",
  },
  {
    name: "INSTAGRAM_APP_ID",
    label: "Instagram app ID",
    group: "meta",
    kind: "text",
    required: true,
    help: "From your Meta app, under Instagram > API setup with Instagram login. This is the Instagram app ID, not the Facebook app ID at the top of the dashboard.",
    source: "Meta app > Instagram > API setup",
  },
  {
    name: "INSTAGRAM_APP_SECRET",
    label: "Instagram app secret",
    group: "meta",
    kind: "secret",
    required: true,
    help: "Sits next to the Instagram app ID in the same panel. Used to exchange the OAuth code for an access token.",
    source: "Meta app > Instagram > API setup",
  },
  {
    name: "FACEBOOK_APP_SECRET",
    label: "Facebook app secret",
    group: "meta",
    kind: "secret",
    required: true,
    help: "From App settings > Basic. This is a different value from the Instagram app secret, and it is the one that verifies the X-Hub-Signature on incoming webhooks.",
    source: "Meta app > App settings > Basic",
  },
  {
    name: "WEBHOOK_VERIFY_TOKEN",
    label: "Webhook verify token",
    group: "meta",
    kind: "secret",
    required: true,
    help: "Any random string you choose. Meta echoes it back once when you register the webhook callback, to prove the URL is yours. Paste the identical value into Meta's webhook config.",
    generator: "hex_16",
  },
  {
    name: "COMMENT_POLL_INTERVAL_MS",
    label: "Sweep interval (ms)",
    group: "tuning",
    kind: "text",
    required: false,
    help: "How often the worker sweeps for comments the webhook missed. Default 300000 (5 minutes).",
    placeholder: "300000",
  },
  {
    name: "COMMENT_POLL_MAX_PER_SWEEP",
    label: "Max comments per sweep",
    group: "tuning",
    kind: "text",
    required: false,
    help: "Cap on how many new comments one campaign acts on per sweep. Raising this moves you toward Instagram's rate limits.",
    placeholder: "30",
  },
  {
    name: "COMMENT_POLL_LOOKBACK_HOURS",
    label: "Sweep lookback (hours)",
    group: "tuning",
    kind: "text",
    required: false,
    help: "How far back a sweep considers comments. Default 72.",
    placeholder: "72",
  },
] as const;

export const FIELDS_BY_NAME: ReadonlyMap<string, EnvField> = new Map(
  ENV_FIELDS.map((field) => [field.name, field])
);

/** Secret fields are masked in every API response; nothing else is. */
export function isSecretField(name: string): boolean {
  return FIELDS_BY_NAME.get(name)?.kind === "secret";
}

/**
 * Field-level validation. Returns an error string, or null when the value is
 * acceptable. Empty values are the caller's business: a missing *required*
 * field is reported by the readiness checks, not here, because a half-filled
 * form is a normal state to be in while you are still setting up.
 */
export function validateFieldValue(name: string, value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  switch (name) {
    case "NEXTAUTH_URL": {
      let parsed: URL;
      try {
        parsed = new URL(trimmed);
      } catch {
        return "Must be a full URL, including http:// or https://";
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return "Must be an http or https URL";
      }
      if (trimmed.endsWith("/")) {
        return "Drop the trailing slash — callback URLs are built by appending to this";
      }
      return null;
    }
    case "NEXTAUTH_SECRET":
      return trimmed.length >= 16
        ? null
        : "Too short to be a useful secret — use at least 16 characters";
    case "ENCRYPTION_KEY":
      return HEX_64.test(trimmed)
        ? null
        : "Must be exactly 64 hex characters (openssl rand -hex 32)";
    case "DATABASE_URL":
      return /^postgres(ql)?:\/\//i.test(trimmed)
        ? null
        : "Must start with postgresql:// or postgres://";
    case "REDIS_URL":
      return /^rediss?:\/\//i.test(trimmed)
        ? null
        : "Must start with redis:// or rediss://";
    case "RESEND_API_KEY":
      return trimmed.startsWith("re_")
        ? null
        : "Resend keys start with re_";
    case "EMAIL_FROM":
      return /.+@.+\..+/.test(trimmed)
        ? null
        : "Needs an email address, optionally as: Name <you@domain.com>";
    case "META_GRAPH_API_VERSION":
      return /^v\d+\.\d+$/.test(trimmed)
        ? null
        : "Looks like v25.0";
    case "COMMENT_POLL_INTERVAL_MS":
    case "COMMENT_POLL_MAX_PER_SWEEP":
    case "COMMENT_POLL_LOOKBACK_HOURS":
      return /^\d+$/.test(trimmed) && Number(trimmed) > 0
        ? null
        : "Must be a positive whole number";
    default:
      return null;
  }
}

/** Values that are technically valid but will not do what you want. */
export function warnAboutFieldValue(name: string, value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  if (name === "NEXTAUTH_URL" && /^https?:\/\/(localhost|127\.0\.0\.1)/i.test(trimmed)) {
    return "Meta cannot deliver webhooks to localhost. Fine while you build; swap in a tunnel or deployed URL before connecting Instagram.";
  }
  if (name === "EMAIL_FROM" && /example\.(com|org|net)/i.test(trimmed)) {
    return "example.com is the placeholder domain and will not deliver. Use a domain you verified in Resend.";
  }
  if (name === "DATABASE_URL" && /railway\.internal/i.test(trimmed)) {
    return "This is Railway's internal hostname. It only resolves inside Railway — the web app on Vercel needs the public proxy URL.";
  }
  if (name === "REDIS_URL" && /railway\.internal/i.test(trimmed)) {
    return "This is Railway's internal hostname. It only resolves inside Railway — the web app on Vercel needs the public proxy URL.";
  }
  return null;
}
