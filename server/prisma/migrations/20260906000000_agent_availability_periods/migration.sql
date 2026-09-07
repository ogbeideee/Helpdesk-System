-- Agent Unavailability Timeline: immutable spans of availability state
-- (online / unavailable / offline). A period opens on a real state transition
-- and stays open (endedAt IS NULL) until the next transition closes it.
-- Pure history: no ticket, assignment, handover or SLA code reads it.

-- CreateTable
CREATE TABLE "AgentAvailabilityPeriod" (
    "id" SERIAL NOT NULL,
    "agentId" INTEGER NOT NULL,
    "state" TEXT NOT NULL,
    "previousState" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "actorId" INTEGER,
    "source" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentAvailabilityPeriod_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentAvailabilityPeriod_agentId_startedAt_idx" ON "AgentAvailabilityPeriod"("agentId" ,"startedAt");

-- CreateIndex
CREATE INDEX "AgentAvailabilityPeriod_endedAt_idx" ON "AgentAvailabilityPeriod"("endedAt");

-- CreateIndex
CREATE INDEX "AgentAvailabilityPeriod_actorId_idx" ON "AgentAvailabilityPeriod"("actorId");

-- AddForeignKey
ALTER TABLE "AgentAvailabilityPeriod" ADD CONSTRAINT "AgentAvailabilityPeriod_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentAvailabilityPeriod" ADD CONSTRAINT "AgentAvailabilityPeriod_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The timeline is a strict per-agent sequence: at most ONE open period per
-- agent, enforced by the database itself so a concurrent or replayed
-- transition can never open a second "current" period. (Partial index —
-- Prisma's schema DSL cannot express it, so it lives here only. Hand-written
-- migrations applied with `prisma migrate deploy` keep it.)
CREATE UNIQUE INDEX "AgentAvailabilityPeriod_one_open_per_agent_key" ON "AgentAvailabilityPeriod"("agentId") WHERE "endedAt" IS NULL;
