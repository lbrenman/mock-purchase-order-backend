'use strict';

const fs = require('fs');
const express = require('express');
const yaml = require('js-yaml');
const swaggerUi = require('swagger-ui-express');
const config = require('../config');

/** Public base URL as seen by the caller (works behind ngrok and Codespaces proxies). */
function externalBaseUrl(req) {
  if (config.publicBaseUrl) return config.publicBaseUrl;
  const proto = String(req.get('x-forwarded-proto') || req.protocol || 'http').split(',')[0].trim();
  const host = String(req.get('x-forwarded-host') || req.get('host') || `localhost:${config.port}`)
    .split(',')[0]
    .trim();
  return `${proto}://${host}`;
}

/**
 * Serves, under the service base path:
 *   GET /openapi.json   spec with `servers` rewritten to the caller-visible URL
 *   GET /openapi.yaml   same, as YAML (import this into the iPaaS)
 *   GET /api-docs       Swagger UI
 */
function docsRouter({ specFile, basePath }) {
  const router = express.Router();
  const raw = yaml.load(fs.readFileSync(specFile, 'utf8'));

  const specFor = (req) => ({
    ...raw,
    servers: [
      { url: `${externalBaseUrl(req)}${basePath}`, description: 'This server (as seen by the caller)' },
      { url: basePath, description: 'Relative to the current origin' },
    ],
  });

  router.get('/openapi.json', (req, res) => res.json(specFor(req)));
  router.get('/openapi.yaml', (req, res) => res.type('text/yaml').send(yaml.dump(specFor(req), { noRefs: true })));

  const uiOptions = {
    customSiteTitle: raw.info && raw.info.title,
    swaggerOptions: { url: `${basePath}/openapi.json`, persistAuthorization: true, displayRequestDuration: true },
  };
  router.use('/api-docs', swaggerUi.serveFiles(null, uiOptions), swaggerUi.setup(null, uiOptions));
  return router;
}

module.exports = { docsRouter, externalBaseUrl };
