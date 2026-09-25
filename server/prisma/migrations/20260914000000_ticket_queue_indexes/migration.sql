-- Queue indexes for the Ticket table. Workload counts, group pools, the
-- balancer and the filtered ticket list all filter on owner/group combined
-- with the open/closed state ("NEW"/"IN_PROGRESS"). The single-column state
-- index already exists; these composites let those queries run from the index
-- alone as ticket volume grows.

-- CreateIndex
CREATE INDEX "Ticket_assignedAgentId_state_idx" ON "Ticket"("assignedAgentId", "state");

-- CreateIndex
CREATE INDEX "Ticket_teamId_state_idx" ON "Ticket"("teamId", "state");
