ALTER TABLE "Notification" ALTER COLUMN "agentId" DROP NOT NULL;
ALTER TABLE "Notification" ADD COLUMN "emailPayload" TEXT,
 ADD COLUMN "emailKind" TEXT, ADD COLUMN "emailStatus" TEXT,
 ADD COLUMN "emailAttempts" INTEGER NOT NULL DEFAULT 0,
 ADD COLUMN "emailNextAttemptAt" TIMESTAMP(3), ADD COLUMN "emailLeaseUntil" TIMESTAMP(3),
 ADD COLUMN "emailDeliveredAt" TIMESTAMP(3), ADD COLUMN "emailError" TEXT;
CREATE INDEX "Notification_emailStatus_emailNextAttemptAt_idx" ON "Notification"("emailStatus", "emailNextAttemptAt");
