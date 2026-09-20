-- CreateEnum
CREATE TYPE "WhatsAppDirection" AS ENUM ('INBOUND', 'OUTBOUND');

-- CreateTable
CREATE TABLE "WhatsAppLead" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "automationId" TEXT,
    "instagramAccountId" TEXT,
    "trackedLinkId" TEXT,
    "chatId" TEXT NOT NULL,
    "sessionId" TEXT,
    "phone" TEXT,
    "displayName" TEXT,
    "refSlug" TEXT,
    "lastInboundAt" TIMESTAMP(3),
    "lastOutboundAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsAppLead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhatsAppMessage" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "direction" "WhatsAppDirection" NOT NULL,
    "providerMessageId" TEXT,
    "body" TEXT NOT NULL,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WhatsAppMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WhatsAppLead_workspaceId_idx" ON "WhatsAppLead"("workspaceId");

-- CreateIndex
CREATE INDEX "WhatsAppLead_automationId_idx" ON "WhatsAppLead"("automationId");

-- CreateIndex
CREATE INDEX "WhatsAppLead_createdAt_idx" ON "WhatsAppLead"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppLead_workspaceId_chatId_key" ON "WhatsAppLead"("workspaceId", "chatId");

-- CreateIndex
CREATE INDEX "WhatsAppMessage_workspaceId_idx" ON "WhatsAppMessage"("workspaceId");

-- CreateIndex
CREATE INDEX "WhatsAppMessage_createdAt_idx" ON "WhatsAppMessage"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppMessage_leadId_providerMessageId_key" ON "WhatsAppMessage"("leadId", "providerMessageId");

-- AddForeignKey
ALTER TABLE "WhatsAppLead" ADD CONSTRAINT "WhatsAppLead_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsAppLead" ADD CONSTRAINT "WhatsAppLead_automationId_fkey" FOREIGN KEY ("automationId") REFERENCES "Automation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsAppLead" ADD CONSTRAINT "WhatsAppLead_instagramAccountId_fkey" FOREIGN KEY ("instagramAccountId") REFERENCES "InstagramAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsAppLead" ADD CONSTRAINT "WhatsAppLead_trackedLinkId_fkey" FOREIGN KEY ("trackedLinkId") REFERENCES "TrackedLink"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsAppMessage" ADD CONSTRAINT "WhatsAppMessage_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsAppMessage" ADD CONSTRAINT "WhatsAppMessage_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "WhatsAppLead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

