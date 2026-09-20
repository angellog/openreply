/**
 * Local sign-in, without email.
 *
 * OpenReply authenticates with magic links only, which means a working Resend
 * key and a verified sending domain are prerequisites for reaching the
 * dashboard — including the dashboard you would use to *configure Resend*. That
 * circularity is the single worst part of first-run setup.
 *
 * This endpoint breaks it. Auth.js is configured with the database session
 * strategy, so a session is nothing more than a row in `Session` plus a cookie
 * holding its token. Both are created here directly. The result is a genuine
 * session, indistinguishable from one earned through a magic link.
 *
 * It is gated by `lib/setup/guard.ts` — closed in production unless explicitly
 * opened with a token — because it is, by design, authentication with no
 * authentication.
 */

import { randomBytes } from "crypto";
import { cookies } from "next/headers";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { ensureWorkspaceForUser } from "@/lib/workspace";
import { guardSetupRequest, setupJson } from "@/lib/setup/route-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SESSION_DAYS = 30;

const schema = z.object({
  email: z.string().trim().email(),
  workspaceName: z.string().trim().min(1).max(80).optional(),
});

export async function POST(request: NextRequest) {
  const { denial } = guardSetupRequest(request);
  if (denial) return denial;

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return setupJson(
      { success: false, error: "Enter a valid email address" },
      { status: 400 }
    );
  }

  const email = parsed.data.email.toLowerCase();

  const user =
    (await prisma.user.findUnique({ where: { email } })) ??
    (await prisma.user.create({
      data: { email, emailVerified: new Date(), name: email.split("@")[0] },
    }));

  // `ensureWorkspaceForUser` also claims any pending invitations for this
  // address, so a locally-created user lands in the same state a magic-link
  // sign-in would have produced.
  const workspace = await ensureWorkspaceForUser(user.id, user.email);

  if (parsed.data.workspaceName && workspace.name !== parsed.data.workspaceName) {
    await prisma.workspace.update({
      where: { id: workspace.id },
      data: { name: parsed.data.workspaceName },
    });
  }

  const sessionToken = randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);

  await prisma.session.create({
    data: { sessionToken, userId: user.id, expires },
  });

  const secure = request.nextUrl.protocol === "https:";
  const cookieStore = await cookies();
  cookieStore.set({
    name: `${secure ? "__Secure-" : ""}authjs.session-token`,
    value: sessionToken,
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure,
    expires,
  });

  return setupJson({
    success: true,
    data: {
      email: user.email,
      workspaceId: workspace.id,
      workspaceName: parsed.data.workspaceName ?? workspace.name,
      expiresAt: expires.toISOString(),
    },
  });
}

/** Sign out of the local session, clearing both the row and the cookie. */
export async function DELETE(request: NextRequest) {
  const { denial } = guardSetupRequest(request);
  if (denial) return denial;

  const secure = request.nextUrl.protocol === "https:";
  const cookieName = `${secure ? "__Secure-" : ""}authjs.session-token`;
  const cookieStore = await cookies();
  const token = cookieStore.get(cookieName)?.value;

  if (token) {
    await prisma.session.deleteMany({ where: { sessionToken: token } });
    cookieStore.delete(cookieName);
  }

  return setupJson({ success: true, data: { signedOut: Boolean(token) } });
}
