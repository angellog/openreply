import { describe, expect, it } from "vitest";
import { checkEnvironment } from "@/lib/setup/checks";
import { buildMetaWizard } from "@/lib/setup/meta-wizard";

const COMPLETE = {
  NEXTAUTH_URL: "https://live.example",
  NEXTAUTH_SECRET: "a-sufficiently-long-secret",
  ENCRYPTION_KEY: "a".repeat(64),
  DATABASE_URL: "postgresql://user@host:5432/openreply",
  REDIS_URL: "redis://host:6379",
  INSTAGRAM_APP_ID: "123",
  INSTAGRAM_APP_SECRET: "shh",
  FACEBOOK_APP_SECRET: "shh",
  WEBHOOK_VERIFY_TOKEN: "token",
  RESEND_API_KEY: "re_abc",
  EMAIL_FROM: "OpenReply <login@mine.com>",
};

/** Drop keys from a fixture without leaving unused bindings behind. */
function omit<T extends Record<string, string>>(
  source: T,
  ...keys: (keyof T)[]
): Record<string, string> {
  const copy: Record<string, string> = { ...source };
  for (const key of keys) delete copy[key as string];
  return copy;
}

describe("checkEnvironment", () => {
  it("passes when everything required is set and well-formed", () => {
    const check = checkEnvironment(COMPLETE);
    expect(check.status).toBe("ok");
  });

  it("fails and names what is missing", () => {
    const withoutKey = omit(COMPLETE, "ENCRYPTION_KEY");
    const check = checkEnvironment(withoutKey);

    expect(check.status).toBe("error");
    expect(check.meta?.missing).toContain("ENCRYPTION_KEY");
    expect(check.remedy).toContain("ENCRYPTION_KEY");
  });

  it("fails on a malformed value, not just a missing one", () => {
    const check = checkEnvironment({ ...COMPLETE, ENCRYPTION_KEY: "too-short" });
    expect(check.status).toBe("error");
    expect(check.meta?.invalid).toContain("ENCRYPTION_KEY");
  });

  it("warns rather than fails on a localhost public URL", () => {
    const check = checkEnvironment({
      ...COMPLETE,
      NEXTAUTH_URL: "http://localhost:3000",
    });
    expect(check.status).toBe("warn");
    expect(check.meta?.warnings).toContain("NEXTAUTH_URL");
  });

  it("does not treat an unset optional field as a problem", () => {
    const withoutEmail = omit(COMPLETE, "RESEND_API_KEY", "EMAIL_FROM");
    expect(checkEnvironment(withoutEmail).status).toBe("ok");
  });

  it("treats whitespace as unset", () => {
    const check = checkEnvironment({ ...COMPLETE, INSTAGRAM_APP_ID: "   " });
    expect(check.status).toBe("error");
    expect(check.meta?.missing).toContain("INSTAGRAM_APP_ID");
  });
});

describe("buildMetaWizard", () => {
  it("derives every URL from the configured base", () => {
    const wizard = buildMetaWizard({
      baseUrl: "https://live.example",
      verifyToken: "tok",
    });

    const values = wizard.steps.flatMap((step) => step.values ?? []);
    const byLabel = new Map(values.map((value) => [value.label, value.value]));

    expect(byLabel.get("OAuth redirect URI")).toBe(
      "https://live.example/api/instagram/callback"
    );
    expect(byLabel.get("Callback URL")).toBe("https://live.example/api/webhook");
    expect(byLabel.get("Verify token")).toBe("tok");
  });

  it("strips any path or trailing slash from the base URL", () => {
    const wizard = buildMetaWizard({
      baseUrl: "https://live.example/some/path",
      verifyToken: "tok",
    });
    expect(wizard.baseUrl).toBe("https://live.example");
  });

  it("flags a localhost base and says so on the webhook step", () => {
    const wizard = buildMetaWizard({
      baseUrl: "http://localhost:3000",
      verifyToken: "tok",
    });
    expect(wizard.isLocal).toBe(true);

    const webhookStep = wizard.steps.find((step) => step.id === "webhook");
    expect(webhookStep?.warning).toContain("tunnel");
  });

  it("does not warn about a real domain", () => {
    const wizard = buildMetaWizard({
      baseUrl: "https://live.example",
      verifyToken: "tok",
    });
    expect(wizard.isLocal).toBe(false);
    expect(wizard.steps.find((step) => step.id === "webhook")?.warning).toBeUndefined();
  });

  it("tells you to generate a verify token when there is none", () => {
    const wizard = buildMetaWizard({ baseUrl: "https://live.example", verifyToken: "" });
    const token = wizard.steps
      .flatMap((step) => step.values ?? [])
      .find((value) => value.label === "Verify token");
    expect(token?.value).toContain("generate");
  });

  it("gives every step instructions", () => {
    const wizard = buildMetaWizard({ baseUrl: "https://a.test", verifyToken: "t" });
    expect(wizard.steps.length).toBeGreaterThan(4);
    for (const step of wizard.steps) {
      expect(step.instructions.length, step.id).toBeGreaterThan(0);
      expect(step.where, step.id).toBeTruthy();
    }
  });

  it("uses unique step ids", () => {
    const wizard = buildMetaWizard({ baseUrl: "https://a.test", verifyToken: "t" });
    expect(new Set(wizard.steps.map((step) => step.id)).size).toBe(wizard.steps.length);
  });
});
