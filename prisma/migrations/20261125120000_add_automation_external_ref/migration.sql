-- The service API (/api/service/v1) addresses campaigns by a caller-chosen
-- reference, e.g. "kickshot:<run>:<page>". Unique per workspace so a retried
-- create returns the existing campaign instead of making a second one.
-- Additive and nullable: existing campaigns are untouched, and Postgres lets
-- any number of rows share a NULL in a unique index.

-- AlterTable
ALTER TABLE "Automation" ADD COLUMN "externalRef" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Automation_workspaceId_externalRef_key" ON "Automation"("workspaceId", "externalRef");
