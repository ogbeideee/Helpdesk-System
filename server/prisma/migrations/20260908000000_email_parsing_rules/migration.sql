-- Admin-configurable email parsing rules. Keywords are a JSON array of
-- literal phrases; scope selects subject/body/both; category, priority and
-- teamKey are optional field overrides. `precedence` orders evaluation
-- (lower wins, ties by id) and `enabled` gates the whole rule.

-- CreateTable
CREATE TABLE "EmailParsingRule" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "keywords" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'both',
    "category" TEXT,
    "priority" TEXT,
    "teamKey" TEXT,
    "precedence" INTEGER NOT NULL DEFAULT 100,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailParsingRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EmailParsingRule_enabled_precedence_idx" ON "EmailParsingRule"("enabled", "precedence");
