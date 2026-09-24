'use strict';

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const config = require('./config');
const { getPool } = require('./shared/db');
const { externalBaseUrl } = require('./shared/docs');

const factories = {
  erp: require('./services/erp'),
  srm: require('./services/srm'),
  tms: require('./services/tms'),
};

morgan.token('cid', (req) => req.correlationId || '-');

function landingHtml(req, names) {
  const base = externalBaseUrl(req);
  const rows = names
    .map((n) => {
      const s = config.services[n];
      return `<tr><td><code>/${n}</code></td><td><strong>${s.title}</strong><br><small>${s.description}</small></td>
        <td><a href="/${n}/api-docs">Swagger UI</a> · <a href="/${n}/openapi.yaml">openapi.yaml</a> · <a href="/${n}/openapi.json">openapi.json</a> · <a href="/${n}/health">health</a></td>
        <td><code>${s.authMode === 'none' ? 'none' : s.apiKeyHeader}</code></td></tr>`;
    })
    .join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Mock Purchase Order Backends</title>
<style>
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:1100px;margin:2rem auto;padding:0 1rem;color:#1d2330;background:#fff}
  h1{margin-bottom:.2rem} p.sub{color:#5a6475;margin-top:0}
  table{border-collapse:collapse;width:100%;margin-top:1rem} td,th{border-bottom:1px solid #e3e7ee;padding:.7rem .5rem;vertical-align:top;text-align:left}
  th{font-size:.8rem;text-transform:uppercase;letter-spacing:.04em;color:#5a6475} small{color:#5a6475} code{background:#f2f4f8;padding:.1rem .3rem;border-radius:4px}
  a{color:#0b5bd3;text-decoration:none} a:hover{text-decoration:underline}
  @media (prefers-color-scheme:dark){body{background:#12151c;color:#e6e9ef}td,th{border-color:#2a303c}code{background:#232937}small,p.sub,th{color:#9aa4b5}a{color:#6ea8ff}}
</style></head><body>
<h1>Mock Purchase Order Backends</h1>
<p class="sub">Three independent systems of record behind the <em>Supplier Order Collaboration API</em>. Base URL: <code>${base}</code></p>
<table><thead><tr><th>Base path</th><th>System</th><th>Docs</th><th>API key header</th></tr></thead><tbody>${rows}</tbody></table>
<p><small>Mode: ${config.serviceMode} · Chaos headers: ${config.chaosEnabled ? 'enabled' : 'disabled'} · <a href="/health">aggregate health</a></small></p>
</body></html>`;
}

/** Build one Express app hosting the given backends (all three in combined mode, one in separate mode). */
function buildApp(names) {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
  app.use(cors({ exposedHeaders: ['X-Correlation-Id', 'ETag', 'Location', 'Retry-After', 'Idempotent-Replayed'] }));
  if (config.logFormat !== 'none') {
    const fmt = config.logFormat === 'dev' ? ':method :url :status :response-time ms cid=:cid' : config.logFormat;
    app.use(morgan(fmt));
  }

  app.get('/', (req, res) => {
    if (req.accepts(['html', 'json']) === 'json') {
      return res.json({
        service: 'mock-purchase-order-backend',
        mode: config.serviceMode,
        backends: names.map((n) => ({
          name: n,
          title: config.services[n].title,
          basePath: `/${n}/v1`,
          docs: `/${n}/api-docs`,
          openapi: `/${n}/openapi.yaml`,
          health: `/${n}/health`,
        })),
      });
    }
    return res.type('html').send(landingHtml(req, names));
  });

  app.get('/health', async (req, res) => {
    const checks = await Promise.all(
      names.map(async (n) => {
        try {
          await getPool(config.services[n].databaseUrl).query('SELECT 1');
          return { service: n, status: 'ok' };
        } catch (err) {
          return { service: n, status: 'down', error: err.message };
        }
      })
    );
    const ok = checks.every((c) => c.status === 'ok');
    res.status(ok ? 200 : 503).json({
      status: ok ? 'ok' : 'degraded',
      version: config.apiVersion,
      service: 'mock-purchase-order-backend',
      timestamp: new Date().toISOString(),
      backends: checks,
    });
  });

  names.forEach((n) => app.use(`/${n}`, factories[n]()));

  app.use((req, res) => {
    res.status(404).json({ error: `No route for ${req.method} ${req.originalUrl}. Backends live under ${names.map((n) => `/${n}`).join(', ')}` });
  });
  return app;
}

module.exports = { buildApp };
