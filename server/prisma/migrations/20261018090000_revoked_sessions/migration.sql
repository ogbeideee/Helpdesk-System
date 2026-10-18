CREATE TABLE "RevokedSession" (
  "tokenHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RevokedSession_pkey" PRIMARY KEY ("tokenHash")
);
CREATE INDEX "RevokedSession_expiresAt_idx" ON "RevokedSession"("expiresAt");
