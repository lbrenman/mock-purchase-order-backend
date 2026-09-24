'use strict';

const express = require('express');
const config = require('../config');
const { getPool } = require('./db');
const { docsRouter } = require('./docs');
const { errorHandler, notFoundHandler } = require('./errors');
const { correlation, apiKeyAuth, chaos, limiter, idempotency } = require('./middleware');

/**
 * Builds a self-contained backend mounted at /<name>:
 *   /<name>/health         unauthenticated
 *   /<name>/openapi.json   unauthenticated
 *   /<name>/openapi.yaml   unauthenticated
 *   /<name>/api-docs       unauthenticated (Swagger UI)
 *   /<name>/v1/...         rate limit -> api key -> chaos -> routes
 */
function createServiceRouter({ name, specFile, formatError, buildRoutes }) {
  const svc = config.services[name];
  const pool = getPool(svc.databaseUrl);
  const router = express.Router();

  router.use(correlation());

  router.get('/health', async (req, res) => {
    const started = Date.now();
    try {
      await pool.query('SELECT 1');
      res.json({
        status: 'ok',
        service: name,
        title: svc.title,
        version: config.apiVersion,
        authMode: svc.authMode,
        database: 'up',
        dbLatencyMs: Date.now() - started,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      res.status(503).json({ status: 'degraded', service: name, database: 'down', error: err.message, timestamp: new Date().toISOString() });
    }
  });

  router.use(docsRouter({ specFile, basePath: `/${name}` }));
  router.use(express.json({ limit: '1mb' }));
  router.use(limiter({ windowMs: config.rateLimitWindowMs, max: svc.rateLimitMax, formatError }));
  router.use(apiKeyAuth({ mode: svc.authMode, apiKey: svc.apiKey, header: svc.apiKeyHeader, formatError }));
  router.use(chaos({ enabled: config.chaosEnabled, latencyMs: svc.latencyMs, errorRate: svc.errorRate, formatError }));

  const idem = idempotency({ pool, schema: name, formatError });
  router.use('/v1', buildRoutes({ pool, svc, idem }));

  router.use(notFoundHandler(formatError));
  router.use(errorHandler(formatError, name));
  return router;
}

module.exports = { createServiceRouter };
