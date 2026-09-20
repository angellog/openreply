/**
 * Mint a correctly-shaped random value for a field that declares a generator.
 *
 * Generated server-side with `crypto.randomBytes` rather than in the browser,
 * so the value never depends on the quality of a page's RNG and the shape rule
 * (64 hex for ENCRYPTION_KEY, and so on) lives next to the field definition.
 */

import type { NextRequest } from "next/server";
import { z } from "zod";
import { guardSetupRequest, setupJson } from "@/lib/setup/route-guard";
import { generateSecret } from "@/lib/setup/env-file";
import { FIELDS_BY_NAME } from "@/lib/setup/fields";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({ name: z.string().min(1) });

export async function POST(request: NextRequest) {
  const { denial } = guardSetupRequest(request);
  if (denial) return denial;

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return setupJson({ success: false, error: "Expected { name }" }, { status: 400 });
  }

  const field = FIELDS_BY_NAME.get(parsed.data.name);
  if (!field?.generator) {
    return setupJson(
      { success: false, error: `${parsed.data.name} has no generator` },
      { status: 400 }
    );
  }

  return setupJson({
    success: true,
    data: { name: field.name, value: generateSecret(field.generator) },
  });
}
