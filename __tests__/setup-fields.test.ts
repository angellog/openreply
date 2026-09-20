import { describe, expect, it } from "vitest";
import {
  ENV_FIELDS,
  FIELDS_BY_NAME,
  FIELD_GROUPS,
  isSecretField,
  validateFieldValue,
  warnAboutFieldValue,
} from "@/lib/setup/fields";
import { serverEnvSchema } from "@/lib/env";

describe("field catalogue", () => {
  it("marks every variable the app requires at boot as required", () => {
    // The console's idea of "required" must not drift from what lib/env.ts
    // actually throws on, or setup would report ready and the app would not boot.
    for (const name of Object.keys(serverEnvSchema.shape)) {
      const field = FIELDS_BY_NAME.get(name);
      expect(field, `${name} is missing from ENV_FIELDS`).toBeDefined();
      expect(field?.required, `${name} should be required`).toBe(true);
    }
  });

  it("has no duplicate names", () => {
    expect(new Set(ENV_FIELDS.map((field) => field.name)).size).toBe(
      ENV_FIELDS.length
    );
  });

  it("puts every field in a declared group", () => {
    const groups = new Set(FIELD_GROUPS.map((group) => group.id));
    for (const field of ENV_FIELDS) {
      expect(groups.has(field.group), `${field.name} has an unknown group`).toBe(true);
    }
  });

  it("explains every field", () => {
    for (const field of ENV_FIELDS) {
      expect(field.help.length, `${field.name} needs help text`).toBeGreaterThan(20);
    }
  });

  it("treats credentials as secrets and connection strings as plain", () => {
    expect(isSecretField("ENCRYPTION_KEY")).toBe(true);
    expect(isSecretField("INSTAGRAM_APP_SECRET")).toBe(true);
    expect(isSecretField("NEXTAUTH_URL")).toBe(false);
  });

  it("only offers generators on fields that should be random", () => {
    for (const field of ENV_FIELDS) {
      if (!field.generator) continue;
      expect(field.kind).toBe("secret");
    }
  });
});

describe("validateFieldValue", () => {
  it("accepts an empty value — a half-filled form is a normal state", () => {
    expect(validateFieldValue("ENCRYPTION_KEY", "")).toBeNull();
    expect(validateFieldValue("NEXTAUTH_URL", "  ")).toBeNull();
  });

  it("enforces the 64-hex ENCRYPTION_KEY the app throws on", () => {
    expect(validateFieldValue("ENCRYPTION_KEY", "a".repeat(64))).toBeNull();
    expect(validateFieldValue("ENCRYPTION_KEY", "a".repeat(63))).not.toBeNull();
    expect(validateFieldValue("ENCRYPTION_KEY", "z".repeat(64))).not.toBeNull();
  });

  it("agrees with the runtime schema on ENCRYPTION_KEY", () => {
    const good = "a".repeat(64);
    expect(validateFieldValue("ENCRYPTION_KEY", good)).toBeNull();
    expect(serverEnvSchema.shape.ENCRYPTION_KEY.safeParse(good).success).toBe(true);

    const bad = "nope";
    expect(validateFieldValue("ENCRYPTION_KEY", bad)).not.toBeNull();
    expect(serverEnvSchema.shape.ENCRYPTION_KEY.safeParse(bad).success).toBe(false);
  });

  it("requires a full URL and rejects a trailing slash", () => {
    expect(validateFieldValue("NEXTAUTH_URL", "https://a.test")).toBeNull();
    expect(validateFieldValue("NEXTAUTH_URL", "a.test")).not.toBeNull();
    // Callback URLs are built by appending, so a trailing slash doubles it.
    expect(validateFieldValue("NEXTAUTH_URL", "https://a.test/")).not.toBeNull();
  });

  it("checks connection string schemes", () => {
    expect(validateFieldValue("DATABASE_URL", "postgresql://u@h/db")).toBeNull();
    expect(validateFieldValue("DATABASE_URL", "postgres://u@h/db")).toBeNull();
    expect(validateFieldValue("DATABASE_URL", "mysql://u@h/db")).not.toBeNull();
    expect(validateFieldValue("REDIS_URL", "rediss://h:6379")).toBeNull();
    expect(validateFieldValue("REDIS_URL", "https://h")).not.toBeNull();
  });

  it("checks the Resend key prefix", () => {
    expect(validateFieldValue("RESEND_API_KEY", "re_abc")).toBeNull();
    expect(validateFieldValue("RESEND_API_KEY", "sk_abc")).not.toBeNull();
  });

  it("accepts a named sender address", () => {
    expect(validateFieldValue("EMAIL_FROM", "OpenReply <a@b.com>")).toBeNull();
    expect(validateFieldValue("EMAIL_FROM", "nobody")).not.toBeNull();
  });

  it("checks the Graph API version shape", () => {
    expect(validateFieldValue("META_GRAPH_API_VERSION", "v25.0")).toBeNull();
    expect(validateFieldValue("META_GRAPH_API_VERSION", "25")).not.toBeNull();
  });

  it("requires positive integers for the polling knobs", () => {
    expect(validateFieldValue("COMMENT_POLL_INTERVAL_MS", "300000")).toBeNull();
    expect(validateFieldValue("COMMENT_POLL_INTERVAL_MS", "0")).not.toBeNull();
    expect(validateFieldValue("COMMENT_POLL_MAX_PER_SWEEP", "-1")).not.toBeNull();
    expect(validateFieldValue("COMMENT_POLL_LOOKBACK_HOURS", "1.5")).not.toBeNull();
  });

  it("has no opinion about opaque credentials", () => {
    expect(validateFieldValue("INSTAGRAM_APP_SECRET", "anything")).toBeNull();
  });
});

describe("warnAboutFieldValue", () => {
  it("flags a localhost public URL, which Meta cannot reach", () => {
    expect(warnAboutFieldValue("NEXTAUTH_URL", "http://localhost:3000")).not.toBeNull();
    expect(warnAboutFieldValue("NEXTAUTH_URL", "https://live.example")).toBeNull();
  });

  it("flags the placeholder sender domain", () => {
    expect(warnAboutFieldValue("EMAIL_FROM", "A <login@example.com>")).not.toBeNull();
    expect(warnAboutFieldValue("EMAIL_FROM", "A <login@mine.com>")).toBeNull();
  });

  it("flags Railway internal hostnames, which Vercel cannot resolve", () => {
    expect(
      warnAboutFieldValue("DATABASE_URL", "postgresql://u@postgres.railway.internal/db")
    ).not.toBeNull();
    expect(
      warnAboutFieldValue("REDIS_URL", "redis://redis.railway.internal:6379")
    ).not.toBeNull();
    expect(
      warnAboutFieldValue("DATABASE_URL", "postgresql://u@x.proxy.rlwy.net/db")
    ).toBeNull();
  });

  it("never warns about an empty value", () => {
    for (const field of ENV_FIELDS) {
      expect(warnAboutFieldValue(field.name, "")).toBeNull();
    }
  });
});
