'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');
const { getPool, closeAll } = require('../shared/db');

/** Idempotent: every statement is CREATE ... IF NOT EXISTS. */
async function migrateService(name) {
  const svc = config.services[name];
  const sql = fs.readFileSync(path.join(__dirname, 'schema', `${name}.sql`), 'utf8');
  await getPool(svc.databaseUrl).query(sql);
}

async function dropService(name) {
  const svc = config.services[name];
  await getPool(svc.databaseUrl).query(`DROP SCHEMA IF EXISTS ${name} CASCADE`);
}

async function migrateAll(names = config.enabledServices) {
  for (const name of names) {
    await migrateService(name);
    console.log(`[migrate] ${name} schema ready`);
  }
}

module.exports = { migrateService, migrateAll, dropService };

if (require.main === module) {
  migrateAll(Object.keys(config.services))
    .then(() => console.log('[migrate] done'))
    .catch((err) => {
      console.error('[migrate] failed:', err.message);
      process.exitCode = 1;
    })
    .finally(closeAll);
}
