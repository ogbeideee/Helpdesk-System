ALTER TABLE "TeamMembership" ADD COLUMN "isPrimary" BOOLEAN NOT NULL DEFAULT false;
INSERT INTO "TeamMembership" ("agentId", "teamId", "isLead", "isPrimary", "createdAt", "updatedAt")
 SELECT "id", "teamId", false, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP FROM "Agent" WHERE "teamId" IS NOT NULL
 ON CONFLICT ("agentId", "teamId") DO UPDATE SET "isPrimary" = true;
-- Agents with existing supporting memberships but no legacy primary get the
-- oldest membership as primary. Every primary is now an actual membership.
UPDATE "TeamMembership" AS m SET "isPrimary" = true
 WHERE m."id" IN (SELECT MIN(x."id") FROM "TeamMembership" x
 WHERE NOT EXISTS (SELECT 1 FROM "TeamMembership" p WHERE p."agentId" = x."agentId" AND p."isPrimary") GROUP BY x."agentId");
CREATE UNIQUE INDEX "TeamMembership_single_primary" ON "TeamMembership"("agentId") WHERE "isPrimary" = true;
ALTER TABLE "Agent" DROP COLUMN "teamId";
