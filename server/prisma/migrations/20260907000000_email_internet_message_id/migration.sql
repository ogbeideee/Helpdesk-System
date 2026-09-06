-- Cross-source email identity. Graph and IMAP both supply the RFC 5322
-- Message-ID, so storing it lets the intake pipeline (a) refuse the same
-- physical message delivered through a second configured source and
-- (b) resolve In-Reply-To/References threading against tickets and replies
-- that were ingested by either source. Angle brackets are stripped before
-- storage so both providers compare equal.

-- AlterTable
ALTER TABLE "Ticket" ADD COLUMN "internetMessageId" TEXT;
ALTER TABLE "Comment" ADD COLUMN "internetMessageId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Ticket_internetMessageId_key" ON "Ticket"("internetMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "Comment_internetMessageId_key" ON "Comment"("internetMessageId");
