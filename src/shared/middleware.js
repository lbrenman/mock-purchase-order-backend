'use strict';

const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { ApiError } = require('./errors');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Echo X-Correlation-Id (or generate one) so traces line up across iPaaS + backends. */
function correlation() {
  return (req, res, next) => {
    const incoming = req.get('x-correlation-id');
    req.correlationId = incoming && incoming.length <= 128 ? incoming : crypto.randomUUID();
    res.set('X-Correlation-Id', req.correlationId);
    next();
  };
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/** Optional API key auth. mode = 'apikey' | 'none'. */
function apiKeyAuth({ mode, apiKey, header, formatError }) {
  if (mode === 'none') return (req, res, next) => next();
  return (req, res, next) => {
    const provided = req.get(header);
    if (!provided) {
      const e = new ApiError(401, 'API_KEY_MISSING', `Missing API key. Supply it in the '${header}' header.`);
      return res.status(401).json(formatError(e, req));
    }
    if (!safeEqual(provided, apiKey)) {
      const e = new ApiError(401, 'API_KEY_INVALID', 'The supplied API key is not valid for this service.');
      return res.status(401).json(formatError(e, req));
    }
    return next();
  };
}

/**
 * Demo helpers for showing resilience patterns in the iPaaS:
 *  - <SVC>_LATENCY_MS    constant artificial latency (e.g. a "slow legacy ERP")
 *  - <SVC>_ERROR_RATE    fraction (0..1) of requests that randomly return 503
 *  - x-mock-delay-ms     per-request latency override (max 30000)
 *  - x-mock-status       per-request forced error status (400-599)
 * Header/random behaviour only applies when CHAOS_ENABLED=true.
 */
function chaos({ enabled, latencyMs, errorRate, formatError }) {
  return async (req, res, next) => {
    let delay = latencyMs || 0;
    if (enabled) {
      const hDelay = parseInt(req.get('x-mock-delay-ms'), 10);
      if (Number.isFinite(hDelay) && hDelay >= 0) delay = Math.min(hDelay, 30000);
      const forced = parseInt(req.get('x-mock-status'), 10);
      const forcedValid = forced >= 400 && forced <= 599;
      const random = errorRate > 0 && Math.random() < errorRate;
      if (forcedValid || random) {
        const status = forcedValid ? forced : 503;
        if (delay) await sleep(delay);
        if (status === 429 || status === 503) res.set('Retry-After', '5');
        const e = new ApiError(
          status,
          'SIMULATED_FAILURE',
          forcedValid ? `Simulated ${status} requested via x-mock-status header` : 'Randomly injected failure (error rate simulation)'
        );
        return res.status(status).json(formatError(e, req));
      }
    }
    if (delay) await sleep(delay);
    return next();
  };
}

function limiter({ windowMs, max, formatError }) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    validate: { xForwardedForHeader: false },
    handler: (req, res) => {
      res.set('Retry-After', String(Math.ceil(windowMs / 1000)));
      const e = new ApiError(429, 'RATE_LIMIT_EXCEEDED', 'Too many requests for this backend. Retry later.');
      res.status(429).json(formatError(e, req));
    },
  });
}

/**
 * Optional Idempotency-Key support for state-changing requests.
 * Same key + same body  -> the stored response is replayed (Idempotent-Replayed: true)
 * Same key + other body -> 422 IDEMPOTENCY_KEY_REUSED
 */
function idempotency({ pool, schema, formatError }) {
  return async (req, res, next) => {
    const key = req.get('idempotency-key');
    if (!key) return next();
    if (key.length < 8 || key.length > 128) {
      const e = new ApiError(400, 'IDEMPOTENCY_KEY_INVALID', 'Idempotency-Key must be 8-128 characters');
      return res.status(400).json(formatError(e, req));
    }
    const path = `${req.method} ${req.baseUrl}${req.path}`;
    const hash = crypto.createHash('sha256').update(JSON.stringify(req.body || {})).digest('hex');
    try {
      const { rows } = await pool.query(
        `SELECT request_hash, status_code, response_body, response_headers
           FROM ${schema}.idempotency_keys WHERE idem_key = $1 AND request_path = $2`,
        [key, path]
      );
      if (rows[0]) {
        if (rows[0].request_hash !== hash) {
          const e = new ApiError(422, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used with a different request body');
          return res.status(422).json(formatError(e, req));
        }
        const headers = rows[0].response_headers || {};
        Object.entries(headers).forEach(([h, v]) => res.set(h, v));
        res.set('Idempotent-Replayed', 'true');
        return res.status(rows[0].status_code).json(rows[0].response_body);
      }
    } catch (err) {
      return next(err);
    }

    const originalJson = res.json.bind(res);
    res.json = (body) => {
      if (res.statusCode < 500) {
        const headers = {};
        ['Location', 'ETag'].forEach((h) => {
          if (res.get(h)) headers[h] = res.get(h);
        });
        pool
          .query(
            `INSERT INTO ${schema}.idempotency_keys
               (idem_key, request_path, request_hash, status_code, response_body, response_headers)
             VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
            [key, path, hash, res.statusCode, JSON.stringify(body), JSON.stringify(headers)]
          )
          .catch((err) => console.error(`[${schema}] failed to store idempotency key:`, err.message));
      }
      return originalJson(body);
    };
    return next();
  };
}

module.exports = { correlation, apiKeyAuth, chaos, limiter, idempotency };
