'use strict';

const config = require('./config');
const { buildApp } = require('./app');
const { migrateAll } = require('./db/migrate');
const { seedIfEmpty } = require('./data/seed');
const { closeAll } = require('./shared/db');

function banner(port, names) {
  const lines = names.map((n) => {
    const s = config.services[n];
    const auth = s.authMode === 'none' ? 'auth: none' : `auth: ${s.apiKeyHeader}=${s.apiKey}`;
    return `   /${n.padEnd(4)} ${s.title.padEnd(34)} http://localhost:${port}/${n}/api-docs   (${auth})`;
  });
  console.log(`\n▶ Listening on http://localhost:${port}\n${lines.join('\n')}\n`);
}

async function main() {
  const names = config.enabledServices;
  names.forEach((n) => {
    const s = config.services[n];
    if (!['apikey', 'none'].includes(s.authMode)) {
      throw new Error(`${n.toUpperCase()}_AUTH_MODE/AUTH_MODE must be 'apikey' or 'none' (got '${s.authMode}')`);
    }
  });

  try {
    if (config.autoMigrate) await migrateAll(names);
    if (config.autoSeed) await seedIfEmpty(names);
  } catch (err) {
    console.error(`\n✖ Database initialisation failed: ${err.message}`);
    if (err.code === 'ECONNREFUSED') console.error('  Is Postgres running? Try: bash scripts/start-postgres.sh');
    console.error('  The server will still start; /health will report the database as down.\n');
  }

  const servers = [];
  if (config.serviceMode === 'separate') {
    names.forEach((n) => {
      const port = config.services[n].port;
      servers.push(buildApp([n]).listen(port, () => banner(port, [n])));
    });
  } else {
    servers.push(buildApp(names).listen(config.port, () => banner(config.port, names)));
  }

  const shutdown = async (sig) => {
    console.log(`\n${sig} received, shutting down...`);
    await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
    await closeAll();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
