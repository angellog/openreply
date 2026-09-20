/**
 * Everything the Setup Console renders, in one request.
 *
 * The console is a status surface, so a single snapshot endpoint keeps the page
 * internally consistent — you never see fresh checks next to stale env values.
 * Secrets are masked here and only revealed through the explicit reveal
 * endpoint, so an over-the-shoulder glance at the page cannot leak a key.
 */

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { guardSetupRequest, setupJson } from "@/lib/setup/route-guard";
import { readEnvFile, getEnvFilePath, maskSecret } from "@/lib/setup/env-file";
import {
  ENV_FIELDS,
  FIELD_GROUPS,
  isSecretField,
  validateFieldValue,
  warnAboutFieldValue,
} from "@/lib/setup/fields";
import { runReadinessChecks } from "@/lib/setup/checks";
import { buildMetaWizard } from "@/lib/setup/meta-wizard";
import { resolveSetupWorkspace } from "@/lib/setup/workspace";
import { listTargets } from "@/lib/setup/targets";
import { auth } from "@/lib/auth";

export const runtime = "nodejs";
// The whole point is live state; a cached snapshot would be actively misleading.
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const { denial } = guardSetupRequest(request);
  if (denial) return denial;

  const envFile = await readEnvFile();

  // The file on disk is the thing being edited, but the *running* process is
  // what the checks actually exercise. Prefer the file so the form reflects
  // unsaved-to-process edits, and surface the difference explicitly below.
  const effective: Record<string, string> = {};
  for (const field of ENV_FIELDS) {
    effective[field.name] = envFile.values[field.name] ?? process.env[field.name] ?? "";
  }

  const staleFields = ENV_FIELDS.filter((field) => {
    const onDisk = (envFile.values[field.name] ?? "").trim();
    const inProcess = (process.env[field.name] ?? "").trim();
    return onDisk !== "" && onDisk !== inProcess;
  }).map((field) => field.name);

  const fields = ENV_FIELDS.map((field) => {
    const value = effective[field.name] ?? "";
    const secret = isSecretField(field.name);
    return {
      name: field.name,
      label: field.label,
      group: field.group,
      kind: field.kind,
      required: field.required,
      help: field.help,
      placeholder: field.placeholder ?? null,
      options: field.options ?? null,
      generator: field.generator ?? null,
      source: field.source ?? null,
      isSet: value.trim().length > 0,
      /** Masked for secrets, plain for everything else. */
      value: secret ? maskSecret(value) : value,
      secret,
      error: validateFieldValue(field.name, value),
      warning: warnAboutFieldValue(field.name, value),
    };
  });

  const origin = request.nextUrl.origin;
  const [readiness, workspace, session] = await Promise.all([
    runReadinessChecks(effective, origin),
    resolveSetupWorkspace(),
    auth().catch(() => null),
  ]);

  const [accounts, targets] = await Promise.all([
    workspace.workspaceId
      ? prisma.instagramAccount
          .findMany({
            where: { workspaceId: workspace.workspaceId },
            select: {
              id: true,
              username: true,
              instagramId: true,
              webhookSubscribed: true,
              tokenExpiresAt: true,
              connectedAt: true,
            },
            orderBy: { connectedAt: "desc" },
          })
          .catch(() => [])
      : Promise.resolve([]),
    workspace.workspaceId
      ? listTargets(workspace.workspaceId).catch(() => [])
      : Promise.resolve([]),
  ]);

  return setupJson({
    success: true,
    data: {
      envFile: {
        path: getEnvFilePath(),
        exists: envFile.exists,
        /** Set on disk but not loaded by this process — needs a restart. */
        staleFields,
      },
      groups: FIELD_GROUPS,
      fields,
      readiness,
      metaWizard: buildMetaWizard({
        baseUrl: effective.NEXTAUTH_URL || origin,
        verifyToken: effective.WEBHOOK_VERIFY_TOKEN ?? "",
      }),
      workspace,
      session: session?.user
        ? { email: session.user.email ?? null, id: session.user.id ?? null }
        : null,
      accounts: accounts.map((account) => ({
        ...account,
        tokenExpiresAt: account.tokenExpiresAt?.toISOString() ?? null,
        connectedAt: account.connectedAt.toISOString(),
      })),
      targets,
      environment: process.env.NODE_ENV ?? "development",
    },
  });
}
