-- Email relevance triage decisions. This table stores operational metadata
-- only: no subject, body, attachment, evidence, or raw model response.

CREATE TABLE "EmailTriageDecision" (
    "id" SERIAL NOT NULL,
    "messageKey" TEXT NOT NULL,
    "channel" TEXT,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "disposition" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION,
    "reasonCode" TEXT,
    "policyCode" TEXT,
    "latencyMs" INTEGER,
    "errorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailTriageDecision_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EmailTriageDecision_messageKey_key" ON "EmailTriageDecision"("messageKey");
CREATE INDEX "EmailTriageDecision_createdAt_idx" ON "EmailTriageDecision"("createdAt");
CREATE INDEX "EmailTriageDecision_action_createdAt_idx" ON "EmailTriageDecision"("action", "createdAt");
CREATE INDEX "EmailTriageDecision_disposition_createdAt_idx" ON "EmailTriageDecision"("disposition", "createdAt");
