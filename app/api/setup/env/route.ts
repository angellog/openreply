/**
 * Writing `.env` from the console, and revealing a secret on request.
 *
 * POST saves. PUT reveals a single value in the clear — a separate verb, and a
 * separate deliberate click in the UI, so secrets are never in a response body
 * that the page fetched on its own.
 */

import type { NextRequest } from "next/server";
import { z } from "zod";
import { guardSetupRequest, setupJson } from "@/lib/setup/route-guard";
import { readEnvFile, writeEnvUpdates } from "@/lib/setup/env-file";
import { FIELDS_BY_NAME, validateFieldValue } from "@/lib/setup/fields";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const saveSchema = z.object({
  updates: z.record(z.string(), z.string()),
});

const revealSchema = z.object({
  name: z.string().min(1),
});

export async function POST(request: NextRequest) {
  const { denial } = guardSetupRequest(request);
  if (denial) return denial;

  const parsed = saveSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return setupJson(
      { success: false, error: "Expected an { updates: { KEY: value } } body" },
      { status: 400 }
    );
  }

  // Only variables the console declares can be written. Without this, the
  // endpoint would be an arbitrary-file-write into the process environment.
  const unknown = Object.keys(parsed.data.updates).filter(
    (name) => !FIELDS_BY_NAME.has(name)
  );
  if (unknown.length > 0) {
    return setupJson(
      {
        success: false,
        error: `Not settable from the console: ${unknown.join(", ")}`,
      },
      { status: 400 }
    );
  }

  const errors: Record<string, string> = {};
  const updates: Record<string, string> = {};
  for (const [name, rawValue] of Object.entries(parsed.data.updates)) {
    const value = rawValue.trim();
    const error = validateFieldValue(name, value);
    if (error) {
      errors[name] = error;
      continue;
    }
    updates[name] = value;
  }

  if (Object.keys(errors).length > 0) {
    return setupJson(
      { success: false, error: "Some values are not valid", errors },
      { status: 400 }
    );
  }

  const result = await writeEnvUpdates(updates);

  return setupJson({
    success: true,
    data: {
      ...result,
      saved: Object.keys(updates),
      // Values that change how the process boots are only picked up on restart.
      // Say so plainly rather than letting a check fail confusingly later.
      restartRequired: Object.keys(updates).some((name) =>
        RESTART_SENSITIVE.has(name)
      ),
    },
  });
}

export async function PUT(request: NextRequest) {
  const { denial } = guardSetupRequest(request);
  if (denial) return denial;

  const parsed = revealSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success || !FIELDS_BY_NAME.has(parsed.data.name)) {
    return setupJson({ success: false, error: "Unknown field" }, { status: 400 });
  }

  const envFile = await readEnvFile();
  const value =
    envFile.values[parsed.data.name] ?? process.env[parsed.data.name] ?? "";

  return setupJson({ success: true, data: { name: parsed.data.name, value } });
}

/**
 * Changing any of these mid-flight leaves the running process disagreeing with
 * the file: connection pools and the Prisma client are built once at boot, and
 * the webhook route reads its verify token from the process environment.
 */
const RESTART_SENSITIVE = new Set([
  "DATABASE_URL",
  "REDIS_URL",
  "NEXTAUTH_URL",
  "NEXTAUTH_SECRET",
  "ENCRYPTION_KEY",
  "RESEND_API_KEY",
  "EMAIL_FROM",
]);
