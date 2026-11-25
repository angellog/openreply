#!/usr/bin/env node
/**
 * Applies Prisma migrations during `npm run vercel-build`, but only for a
 * Production deploy.
 *
 * Every env var on this Vercel project is Production-scoped, so a preview
 * build has no DATABASE_URL and `prisma migrate deploy` used to fail it before
 * `next build` even started — every pull request showed a red Vercel check
 * that said nothing about the code. A preview must never migrate the
 * production database anyway, so previews skip this step and still build.
 *
 * On Production nothing changes: the migration runs, and if it fails (or
 * DATABASE_URL is missing) the deploy fails, exactly as before. Outside Vercel
 * (VERCEL_ENV unset) it also runs, so a self-hoster's `vercel-build` behaves as
 * it always did.
 */

import { spawnSync } from "node:child_process";

const vercelEnv = process.env.VERCEL_ENV;

if (vercelEnv && vercelEnv !== "production") {
  console.log(
    `[migrate] VERCEL_ENV=${vercelEnv}: skipping prisma migrate deploy. Only Production deploys migrate the database.`
  );
  process.exit(0);
}

const result = spawnSync("npx", ["prisma", "migrate", "deploy"], {
  stdio: "inherit",
  shell: process.platform === "win32",
});
process.exit(result.status ?? 1);
