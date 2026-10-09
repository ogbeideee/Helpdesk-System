ALTER TABLE "Comment" ADD COLUMN "threadingMetadata" TEXT;
ALTER TABLE "Comment" ADD COLUMN "linkedAt" TIMESTAMP(3);
UPDATE "Comment" SET "linkedAt" = "createdAt";
ALTER TABLE "Comment" ALTER COLUMN "linkedAt" SET DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "Comment" ALTER COLUMN "linkedAt" SET NOT NULL;
CREATE INDEX "Comment_ticketId_linkedAt_idx" ON "Comment"("ticketId", "linkedAt");
CREATE TABLE "TicketConversationRead" (
  "ticketId" INTEGER NOT NULL REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "agentId" INTEGER NOT NULL REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "lastReadAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TicketConversationRead_pkey" PRIMARY KEY ("ticketId", "agentId")
);
CREATE INDEX "TicketConversationRead_agentId_idx" ON "TicketConversationRead"("agentId");
