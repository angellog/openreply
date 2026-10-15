-- Harvey bridge: a mirror of the outbound agent's companies, prospects and
-- outbox, plus a durable command queue the operator's decisions travel
-- through. Harvey polls; nothing here ever pushes to the operator's
-- machine, so there is no inbound port to open.
--
-- Several agents may share a workspace (one per brand), so everything is
-- keyed by (agentId, harveyId): Harvey's row ids are only unique per
-- instance.

-- CreateEnum
CREATE TYPE "HarveyAgentStatus" AS ENUM ('ACTIVE', 'REVOKED');

-- CreateEnum
CREATE TYPE "HarveyEmailStatus" AS ENUM ('PENDING_REVIEW', 'APPROVED', 'SENT', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "HarveyCommandKind" AS ENUM ('APPROVE_EMAIL', 'REJECT_EMAIL', 'EDIT_EMAIL', 'APPROVE_ALL', 'PAUSE_SENDING', 'RESUME_SENDING');

-- AlterEnum
ALTER TYPE "OperationalEventSource" ADD VALUE 'HARVEY';

-- CreateTable
CREATE TABLE "HarveyAgent" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "HarveyAgentStatus" NOT NULL DEFAULT 'ACTIVE',
    "secretEncrypted" TEXT NOT NULL,
    "secretPrefix" TEXT NOT NULL,
    "whatsappPhone" TEXT,
    "whatsappMessage" TEXT,
    "whatsappGreeting" TEXT,
    "defaultDestinationUrl" TEXT,
    "lastSeenAt" TIMESTAMP(3),
    "lastSyncAt" TIMESTAMP(3),
    "agentVersion" TEXT,
    "brainProvider" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HarveyAgent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HarveyCompany" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "harveyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "domain" TEXT,
    "website" TEXT,
    "industry" TEXT,
    "location" TEXT,
    "sourceUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HarveyCompany_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HarveyProspect" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "harveyId" TEXT NOT NULL,
    "companyId" TEXT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT NOT NULL,
    "emailStatus" TEXT,
    "title" TEXT,
    "status" TEXT,
    "score" INTEGER,
    "personalizationNotes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HarveyProspect_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HarveyEmail" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "harveyId" TEXT NOT NULL,
    "prospectId" TEXT,
    "campaignHarveyId" TEXT,
    "step" INTEGER NOT NULL DEFAULT 1,
    "kind" TEXT NOT NULL DEFAULT 'sequence',
    "toEmail" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" "HarveyEmailStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
    "sendAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "error" TEXT,
    "trackedLinkId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HarveyEmail_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HarveyCommand" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "kind" "HarveyCommandKind" NOT NULL,
    "targetHarveyId" TEXT,
    "payload" JSONB,
    "issuedByUserId" TEXT,
    "deliveredAt" TIMESTAMP(3),
    "ackedAt" TIMESTAMP(3),
    "result" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HarveyCommand_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "HarveyAgent_workspaceId_idx" ON "HarveyAgent"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "HarveyAgent_workspaceId_name_key" ON "HarveyAgent"("workspaceId", "name");

-- CreateIndex
CREATE INDEX "HarveyCompany_workspaceId_idx" ON "HarveyCompany"("workspaceId");

-- CreateIndex
CREATE INDEX "HarveyCompany_workspaceId_domain_idx" ON "HarveyCompany"("workspaceId", "domain");

-- CreateIndex
CREATE UNIQUE INDEX "HarveyCompany_agentId_harveyId_key" ON "HarveyCompany"("agentId", "harveyId");

-- CreateIndex
CREATE INDEX "HarveyProspect_workspaceId_idx" ON "HarveyProspect"("workspaceId");

-- CreateIndex
CREATE INDEX "HarveyProspect_workspaceId_email_idx" ON "HarveyProspect"("workspaceId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "HarveyProspect_agentId_harveyId_key" ON "HarveyProspect"("agentId", "harveyId");

-- CreateIndex
CREATE INDEX "HarveyEmail_workspaceId_idx" ON "HarveyEmail"("workspaceId");

-- CreateIndex
CREATE INDEX "HarveyEmail_workspaceId_status_idx" ON "HarveyEmail"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "HarveyEmail_createdAt_idx" ON "HarveyEmail"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "HarveyEmail_agentId_harveyId_key" ON "HarveyEmail"("agentId", "harveyId");

-- CreateIndex
CREATE INDEX "HarveyCommand_agentId_ackedAt_idx" ON "HarveyCommand"("agentId", "ackedAt");

-- CreateIndex
CREATE INDEX "HarveyCommand_workspaceId_idx" ON "HarveyCommand"("workspaceId");

-- AddForeignKey
ALTER TABLE "HarveyAgent" ADD CONSTRAINT "HarveyAgent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HarveyCompany" ADD CONSTRAINT "HarveyCompany_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HarveyCompany" ADD CONSTRAINT "HarveyCompany_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "HarveyAgent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HarveyProspect" ADD CONSTRAINT "HarveyProspect_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HarveyProspect" ADD CONSTRAINT "HarveyProspect_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "HarveyAgent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HarveyProspect" ADD CONSTRAINT "HarveyProspect_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "HarveyCompany"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HarveyEmail" ADD CONSTRAINT "HarveyEmail_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HarveyEmail" ADD CONSTRAINT "HarveyEmail_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "HarveyAgent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HarveyEmail" ADD CONSTRAINT "HarveyEmail_prospectId_fkey" FOREIGN KEY ("prospectId") REFERENCES "HarveyProspect"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HarveyEmail" ADD CONSTRAINT "HarveyEmail_trackedLinkId_fkey" FOREIGN KEY ("trackedLinkId") REFERENCES "TrackedLink"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HarveyCommand" ADD CONSTRAINT "HarveyCommand_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HarveyCommand" ADD CONSTRAINT "HarveyCommand_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "HarveyAgent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

