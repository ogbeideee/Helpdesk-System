CREATE TABLE "AgentWeeklyReportReference" (
 "agentId" INTEGER PRIMARY KEY REFERENCES "Agent"("id") ON DELETE CASCADE,
 "data" JSONB NOT NULL
);
