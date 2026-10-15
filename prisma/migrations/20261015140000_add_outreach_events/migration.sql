-- The event stream an outbound agent reads to find out what happened
-- after it sent: clicks, and replies that arrived on WhatsApp instead
-- of by email. Append-only, with a monotonic seq the agent uses as a
-- cursor.

-- CreateEnum
CREATE TYPE "OutreachEventType" AS ENUM ('LINK_CLICKED', 'WHATSAPP_STARTED', 'WHATSAPP_MESSAGE_IN', 'RESOURCE_CLAIMED');

-- CreateTable
CREATE TABLE "OutreachEvent" (
    "seq" SERIAL NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "agentId" TEXT,
    "type" "OutreachEventType" NOT NULL,
    "prospectHarveyId" TEXT,
    "emailHarveyId" TEXT,
    "trackedLinkSlug" TEXT,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutreachEvent_pkey" PRIMARY KEY ("seq")
);

-- CreateIndex
CREATE INDEX "OutreachEvent_agentId_seq_idx" ON "OutreachEvent"("agentId", "seq");

-- CreateIndex
CREATE INDEX "OutreachEvent_workspaceId_createdAt_idx" ON "OutreachEvent"("workspaceId", "createdAt");

-- AddForeignKey
ALTER TABLE "OutreachEvent" ADD CONSTRAINT "OutreachEvent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachEvent" ADD CONSTRAINT "OutreachEvent_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "HarveyAgent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

