-- Resource library: a public lead-magnet hub per brand, and the addresses
-- it collects. Consent is stored with its exact wording and timestamp,
-- because only an explicitly consented lead is ever offered to the
-- outbound agent.

-- CreateEnum
CREATE TYPE "ResourceDeliveryStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

-- AlterTable
ALTER TABLE "Workspace" ADD COLUMN     "publicSlug" TEXT;

-- CreateTable
CREATE TABLE "Resource" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "description" TEXT,
    "destinationUrl" TEXT NOT NULL,
    "kind" TEXT,
    "isPublished" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Resource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResourceLead" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "consentMarketing" BOOLEAN NOT NULL DEFAULT false,
    "consentText" TEXT,
    "consentedAt" TIMESTAMP(3),
    "refSlug" TEXT,
    "trackedLinkId" TEXT,
    "ipHash" TEXT,
    "userAgent" TEXT,
    "referrer" TEXT,
    "deliveryStatus" "ResourceDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "deliveryError" TEXT,
    "exportedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ResourceLead_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Resource_workspaceId_isPublished_idx" ON "Resource"("workspaceId", "isPublished");

-- CreateIndex
CREATE UNIQUE INDEX "Resource_workspaceId_slug_key" ON "Resource"("workspaceId", "slug");

-- CreateIndex
CREATE INDEX "ResourceLead_workspaceId_createdAt_idx" ON "ResourceLead"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "ResourceLead_workspaceId_consentMarketing_exportedAt_idx" ON "ResourceLead"("workspaceId", "consentMarketing", "exportedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ResourceLead_resourceId_email_key" ON "ResourceLead"("resourceId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "Workspace_publicSlug_key" ON "Workspace"("publicSlug");

-- AddForeignKey
ALTER TABLE "Resource" ADD CONSTRAINT "Resource_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResourceLead" ADD CONSTRAINT "ResourceLead_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResourceLead" ADD CONSTRAINT "ResourceLead_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "Resource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResourceLead" ADD CONSTRAINT "ResourceLead_trackedLinkId_fkey" FOREIGN KEY ("trackedLinkId") REFERENCES "TrackedLink"("id") ON DELETE SET NULL ON UPDATE CASCADE;

