-- Remote Access foundation: controlled remote-support sessions tied to one
-- ticket and one agent. Application-side bookkeeping only — no transport, no
-- credentials (the table has no field a secret could live in).

-- CreateTable
CREATE TABLE "RemoteAccessSession" (
    "id" SERIAL NOT NULL,
    "ticketId" INTEGER NOT NULL,
    "agentId" INTEGER NOT NULL,
    "requestedById" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'requested',
    "requestedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "note" TEXT,
    "endReason" TEXT,
    "endedById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RemoteAccessSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RemoteAccessSession_ticketId_status_idx" ON "RemoteAccessSession"("ticketId" ,"status");

-- CreateIndex
CREATE INDEX "RemoteAccessSession_agentId_status_idx" ON "RemoteAccessSession"("agentId" ,"status");

-- CreateIndex
CREATE INDEX "RemoteAccessSession_status_expiresAt_idx" ON "RemoteAccessSession"("status" ,"expiresAt");

-- At most ONE live (requested|active) session per ticket and per agent,
-- enforced by the database itself so a concurrent or replayed create can
-- never open a second live session. (Partial indexes — Prisma's schema DSL
-- cannot express them, so they live here only. Hand-written migrations
-- applied with `prisma migrate deploy` keep them. Finished sessions —
-- ended/cancelled/expired — do not participate and are pure history.)
CREATE UNIQUE INDEX "RemoteAccessSession_one_live_per_ticket_key" ON "RemoteAccessSession"("ticketId") WHERE status IN ('requested', 'active');
CREATE UNIQUE INDEX "RemoteAccessSession_one_live_per_agent_key" ON "RemoteAccessSession"("agentId") WHERE status IN ('requested', 'active');

-- AddForeignKey
ALTER TABLE "RemoteAccessSession" ADD CONSTRAINT "RemoteAccessSession_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RemoteAccessSession" ADD CONSTRAINT "RemoteAccessSession_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RemoteAccessSession" ADD CONSTRAINT "RemoteAccessSession_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RemoteAccessSession" ADD CONSTRAINT "RemoteAccessSession_endedById_fkey" FOREIGN KEY ("endedById") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
