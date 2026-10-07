-- Migration: add the Agent ↔ Assignment Group membership join table.
--
-- Target platform: SQLite. Intended to be applied idempotently on top of the
-- existing single-group schema (Agent.teamId). It is deliberately additive:
--
--   - creates TeamMembership (agentId, teamId, isLead)
--   - backfills existing single-group membership from Agent.teamId
--   - enforces "one lead per group" with a partial unique index (SQLite
--     cannot express that in a table constraint, and Prisma has no schema
--     syntax for it on SQLite)
--
-- It never deletes or rewrites users, teams, tickets or a ticket's current
-- / originating assignment group. Agent.teamId is retained for the
-- transition phase because routing and workload still read it.

-- CreateTable
CREATE TABLE "TeamMembership" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "agentId" INTEGER NOT NULL,
    "teamId" INTEGER NOT NULL,
    "isLead" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TeamMembership_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TeamMembership_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "TeamMembership_teamId_idx" ON "TeamMembership"("teamId");

-- CreateIndex
CREATE UNIQUE INDEX "TeamMembership_agentId_teamId_key" ON "TeamMembership"("agentId", "teamId");

-- Backfill: migrate every existing single-group membership (Agent.teamId)
-- into the join table, preserving all users, all groups and all membership
-- data. The legacy schema stores no lead information, so every migrated row
-- starts as a plain member (isLead = 0); leads are assigned in the next
-- phase. Idempotent: guarded against an (agentId, teamId) pair already
-- present.
INSERT INTO "TeamMembership" ("agentId", "teamId", "isLead")
SELECT "id", "teamId", 0
FROM "Agent"
WHERE "teamId" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "TeamMembership" m
    WHERE m."agentId" = "Agent"."id" AND m."teamId" = "Agent"."teamId"
  );

-- One lead per group: a partial unique index permits at most one row with
-- isLead = 1 per teamId. Cannot be expressed in the Prisma schema for
-- SQLite, so it lives here and in scripts/migrate-assignment-groups.js
-- (which re-creates it for databases updated via `prisma db push`).
CREATE UNIQUE INDEX "TeamMembership_single_lead"
ON "TeamMembership"("teamId")
WHERE "isLead" = 1;