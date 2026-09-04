const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
p.$queryRawUnsafe('SHOW server_version')
  .then(r => console.log('server_version:', r[0].server_version))
  .finally(() => p.$disconnect());