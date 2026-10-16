/**
 * Seeds a local database with a deliberate mix of system states, so the
 * systems map, the sidebar dots and the per-page notices can be looked at
 * rather than imagined: Instagram running, WhatsApp unconfigured, Harvey
 * paired but missing its handoff, the resource hub published but unable to
 * send mail.
 *
 * Run it against a throwaway database and nothing else:
 *
 *   createdb openreply_dev
 *   DATABASE_URL="postgresql://localhost:5432/openreply_dev" \
 *     npx prisma migrate deploy
 *   DATABASE_URL="postgresql://localhost:5432/openreply_dev" \
 *     npx tsx prisma/seed-local.mts
 *
 * The rows it writes are fiction — a fake Instagram account, fake prospects,
 * fake drafted emails. Loose in a real workspace they would be indistinguishable
 * from real leads, so the guard below refuses to run anywhere but localhost.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../app/generated/prisma/client";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

// Host-only check, deliberately strict: a hostname this script does not
// recognise is treated as somebody's real database, not as a new kind of local
// one. Being wrong in the other direction means writing fake prospects into a
// workspace that sends real email.
const host = new URL(databaseUrl).hostname;
if (!["localhost", "127.0.0.1", "::1", ""].includes(host)) {
  throw new Error(
    `Refusing to seed: ${host} is not a local database. This script writes ` +
      `fake accounts, prospects and drafted emails, which are indistinguishable ` +
      `from real ones once they are in a workspace.`
  );
}

const prisma = new PrismaClient({ adapter: new PrismaPg(databaseUrl) });

const SESSION_TOKEN = "local-verify-session-token";

const user = await prisma.user.upsert({
  where: { email: "local@example.test" },
  update: {},
  create: { email: "local@example.test", name: "Local Operator" },
});

const workspace = await prisma.workspace.upsert({
  where: { publicSlug: "vantik" },
  update: {},
  create: { name: "Vantik", ownerId: user.id, publicSlug: "vantik" },
});

await prisma.workspaceMember.upsert({
  where: { workspaceId_userId: { workspaceId: workspace.id, userId: user.id } },
  update: {},
  create: { workspaceId: workspace.id, userId: user.id, role: "OWNER" },
});

await prisma.session.upsert({
  where: { sessionToken: SESSION_TOKEN },
  update: { expires: new Date(Date.now() + 7 * 86400000) },
  create: {
    sessionToken: SESSION_TOKEN,
    userId: user.id,
    expires: new Date(Date.now() + 7 * 86400000),
  },
});

// Instagram: healthy and sending, so it reads "Running".
const account = await prisma.instagramAccount.upsert({
  where: { instagramId: "17841400000000000" },
  update: {},
  create: {
    workspaceId: workspace.id,
    instagramId: "17841400000000000",
    username: "feetbit",
    name: "FeetBit",
    accessToken: "not-a-real-token",
    tokenExpiresAt: new Date(Date.now() + 45 * 86400000),
    webhookSubscribed: true,
  },
});

const automation = await prisma.automation.upsert({
  where: { id: "seed_automation_1" },
  update: {},
  create: {
    id: "seed_automation_1",
    workspaceId: workspace.id,
    instagramAccountId: account.id,
    name: "Sandal drop — comment SIZE",
    keywords: ["size"],
    dmMessage: "Here you go — tap below to chat on WhatsApp.",
    isActive: true,
  },
});

const existingLogs = await prisma.dmLog.count({ where: { workspaceId: workspace.id } });
if (existingLogs === 0) {
  await prisma.dmLog.createMany({
    data: Array.from({ length: 12 }, (_, i) => ({
      workspaceId: workspace.id,
      automationId: automation.id,
      instagramAccountId: account.id,
      commentId: `seed_comment_${i}`,
      commenterId: `seed_user_${i % 5}`,
      commentText: "size?",
      matchedKeyword: "size",
      status: "SENT",
      createdAt: new Date(Date.now() - i * 3600000),
    })),
  });
}

// Harvey: paired, but with no handoff set and drafts waiting — the exact state
// that should rank "no handoff" above "7 waiting", because approving an email
// with no handoff sends a dead end.
const agent = await prisma.harveyAgent.upsert({
  where: { workspaceId_name: { workspaceId: workspace.id, name: "feetbit-contracts" } },
  update: { lastSeenAt: new Date(Date.now() - 4 * 60000) },
  create: {
    workspaceId: workspace.id,
    name: "feetbit-contracts",
    secretEncrypted: "seed-not-a-real-secret",
    secretPrefix: "hv_seed",
    lastSeenAt: new Date(Date.now() - 4 * 60000),
    agentVersion: "0.9.0",
    brainProvider: "claude-cli",
  },
});

const existingEmails = await prisma.harveyEmail.count({ where: { workspaceId: workspace.id } });
if (existingEmails === 0) {
  const company = await prisma.harveyCompany.create({
    data: {
      workspaceId: workspace.id,
      agentId: agent.id,
      harveyId: "cmp_seed_0001",
      name: "Kampala Footwear Co",
      domain: "kampalafootwear.test",
    },
  });
  for (let i = 0; i < 3; i++) {
    const prospect = await prisma.harveyProspect.create({
      data: {
        workspaceId: workspace.id,
        agentId: agent.id,
        companyId: company.id,
        harveyId: `prs_seed_000${i}`,
        firstName: ["Amina", "Joseph", "Grace"][i],
        lastName: "N.",
        title: "Procurement Lead",
        email: `buyer${i}@kampalafootwear.test`,
        score: 70 + i,
      },
    });
    await prisma.harveyEmail.create({
      data: {
        workspaceId: workspace.id,
        agentId: agent.id,
        prospectId: prospect.id,
        harveyId: `eml_seed_000${i}`,
        subject: "Wholesale sandals, Kampala",
        body: "Short first touch, no link in email one.",
        toEmail: prospect.email,
        step: 1,
        kind: "COLD",
        status: "PENDING_REVIEW",
      },
    });
  }
}

// Resource hub: a published resource, no claims yet.
await prisma.resource.upsert({
  where: { workspaceId_slug: { workspaceId: workspace.id, slug: "wholesale-checklist" } },
  update: {},
  create: {
    workspaceId: workspace.id,
    slug: "wholesale-checklist",
    title: "Wholesale buyer checklist",
    summary: "The eleven questions to ask before placing a first order.",
    destinationUrl: "https://drive.example.test/checklist",
    kind: "Checklist",
    isPublished: true,
  },
});

console.log("seeded. session token:", SESSION_TOKEN);
await prisma.$disconnect();
