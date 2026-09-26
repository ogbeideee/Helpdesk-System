require("dotenv").config();
const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();

async function main() {
  const agents = await p.agent.findMany({
    where: { name: { contains: "Ibiyemi", mode: "insensitive" } },
    include: { team: true, memberships: { include: { team: true } } }
  });
  console.log("=== IBIYEMI ===");
  console.log(JSON.stringify(agents, null, 2));

  const rules = await p.routingRule.findMany({
    include: { team: true },
    orderBy: { priority: "asc" }
  });
  console.log("=== RULES ===");
  console.log(JSON.stringify(rules.map(r => ({
    id: r.id,
    name: r.name,
    priority: r.priority,
    category: r.category,
    teamKey: r.team.key,
    teamName: r.team.name,
    keywords: r.keywords.split("\n").filter(Boolean)
  })), null, 2));

  const teams = await p.team.findMany();
  console.log("=== TEAMS ===");
  console.log(JSON.stringify(teams.map(t => ({ id: t.id, key: t.key, name: t.name })), null, 2));
}

main().catch(console.error).finally(() => p.$disconnect());
