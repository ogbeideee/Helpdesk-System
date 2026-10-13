CREATE TABLE "AgentWeeklyReport" (
 "id" SERIAL PRIMARY KEY,
 "agentId" INTEGER NOT NULL REFERENCES "Agent"("id") ON DELETE CASCADE,
 "week" TEXT NOT NULL,
 "data" JSONB NOT NULL,
 "version" INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX "AgentWeeklyReport_agentId_week_key" ON "AgentWeeklyReport"("agentId", "week");
CREATE TABLE "WeeklyActivityDefinition" (
 "id" TEXT PRIMARY KEY, "label" TEXT NOT NULL, "category" TEXT NOT NULL, "active" BOOLEAN NOT NULL DEFAULT true
);
