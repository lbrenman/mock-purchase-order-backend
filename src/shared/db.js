'use strict';

const { Pool, types } = require('pg');

// Return DATE columns as plain 'YYYY-MM-DD' strings (avoids timezone shifts).
types.setTypeParser(1082, (v) => v);
// NUMERIC stays a string by default; each service formats it deliberately.

const pools = new Map();

/** One pool per connection string, shared by services that point at the same DB. */
function getPool(connectionString) {
  if (!connectionString) throw new Error('No database connection string configured');
  if (!pools.has(connectionString)) {
    const pool = new Pool({ connectionString, max: 10, idleTimeoutMillis: 30000 });
    pool.on('error', (err) => console.error('[db] idle client error:', err.message));
    pools.set(connectionString, pool);
  }
  return pools.get(connectionString);
}

/** Run fn(client) inside a transaction. */
async function withTransaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function closeAll() {
  await Promise.all([...pools.values()].map((p) => p.end().catch(() => {})));
  pools.clear();
}

module.exports = { getPool, withTransaction, closeAll };
