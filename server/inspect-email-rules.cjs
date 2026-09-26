require("dotenv").config();
const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();

async function main() {
  const rules = await p.emailParsingRule.findMany();
  console.log("=== EMAIL PARSING RULES ===");
  console.log(JSON.stringify(rules, null, 2));
}

main().catch(console.error).finally(() => p.$disconnect());
