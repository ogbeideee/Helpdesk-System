-- AlterTable
ALTER TABLE "Ticket" ADD COLUMN     "firstResponseAt" TIMESTAMP(3),
ADD COLUMN     "responseBreached" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "responseDueAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "TicketSlaCycle" (
    "id" SERIAL NOT NULL,
    "ticketId" INTEGER NOT NULL,
    "cycleNumber" INTEGER NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "responseDueAt" TIMESTAMP(3),
    "resolutionDueAt" TIMESTAMP(3),
    "responseApproachAt" TIMESTAMP(3),
    "resolutionApproachAt" TIMESTAMP(3),
    "firstResponseAt" TIMESTAMP(3),
    "firstResponderId" INTEGER,
    "assignedAgentId" INTEGER,
    "teamId" INTEGER,
    "responseDurationMs" INTEGER,
    "resolutionDurationMs" INTEGER,
    "responseBreached" BOOLEAN NOT NULL DEFAULT false,
    "resolutionBreached" BOOLEAN NOT NULL DEFAULT false,
    "responseApproached" BOOLEAN NOT NULL DEFAULT false,
    "resolutionApproached" BOOLEAN NOT NULL DEFAULT false,
    "source" TEXT NOT NULL DEFAULT 'live',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TicketSlaCycle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TicketSlaEvent" (
    "id" SERIAL NOT NULL,
    "ticketId" INTEGER NOT NULL,
    "cycleId" INTEGER,
    "type" TEXT NOT NULL,
    "clock" TEXT,
    "at" TIMESTAMP(3) NOT NULL,
    "actor" TEXT NOT NULL DEFAULT 'system',
    "detail" TEXT,
    "metadata" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TicketSlaEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SlaHoliday" (
    "id" SERIAL NOT NULL,
    "date" DATE NOT NULL,
    "name" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SlaHoliday_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TicketSlaCycle_assignedAgentId_endedAt_idx" ON "TicketSlaCycle"("assignedAgentId", "endedAt");

-- CreateIndex
CREATE INDEX "TicketSlaCycle_teamId_endedAt_idx" ON "TicketSlaCycle"("teamId", "endedAt");

-- CreateIndex
CREATE INDEX "TicketSlaCycle_responseDueAt_idx" ON "TicketSlaCycle"("responseDueAt");

-- CreateIndex
CREATE INDEX "TicketSlaCycle_resolutionDueAt_idx" ON "TicketSlaCycle"("resolutionDueAt");

-- CreateIndex
CREATE UNIQUE INDEX "TicketSlaCycle_ticketId_cycleNumber_key" ON "TicketSlaCycle"("ticketId", "cycleNumber");

-- CreateIndex
CREATE INDEX "TicketSlaEvent_ticketId_at_idx" ON "TicketSlaEvent"("ticketId", "at");

-- CreateIndex
CREATE INDEX "TicketSlaEvent_cycleId_idx" ON "TicketSlaEvent"("cycleId");

-- CreateIndex
CREATE UNIQUE INDEX "SlaHoliday_date_key" ON "SlaHoliday"("date");

-- AddForeignKey
ALTER TABLE "TicketSlaCycle" ADD CONSTRAINT "TicketSlaCycle_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketSlaCycle" ADD CONSTRAINT "TicketSlaCycle_firstResponderId_fkey" FOREIGN KEY ("firstResponderId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketSlaCycle" ADD CONSTRAINT "TicketSlaCycle_assignedAgentId_fkey" FOREIGN KEY ("assignedAgentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketSlaCycle" ADD CONSTRAINT "TicketSlaCycle_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketSlaEvent" ADD CONSTRAINT "TicketSlaEvent_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketSlaEvent" ADD CONSTRAINT "TicketSlaEvent_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "TicketSlaCycle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

