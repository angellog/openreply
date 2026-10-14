-- Outbound channels (Harvey cold email) hand out tracked links too, and
-- they have no Automation and no Instagram account behind them. Relaxing
-- these three columns is backward compatible: existing rows keep their
-- values, and every existing query filters by a specific automationId, so
-- NULL rows stay out of the Instagram reports rather than skewing them.

-- CreateEnum
CREATE TYPE "TrackedLinkSource" AS ENUM ('INSTAGRAM', 'HARVEY_EMAIL');

-- AlterTable
ALTER TABLE "TrackedLink" ADD COLUMN     "source" "TrackedLinkSource" NOT NULL DEFAULT 'INSTAGRAM',
ALTER COLUMN "automationId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "LinkClick" ALTER COLUMN "automationId" DROP NOT NULL,
ALTER COLUMN "instagramAccountId" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "TrackedLink_workspaceId_source_idx" ON "TrackedLink"("workspaceId", "source");

