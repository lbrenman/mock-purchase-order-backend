'use strict';

require('dotenv').config();

const bool = (v, d) =>
  v === undefined || v === '' ? d : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
const int = (v, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
};
const num = (v, d) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : d;
};

const DEFAULT_DB = 'postgresql://api_user:api_pass@localhost:5432/po_backends_db';

/**
 * Each backend is configured independently so it can be demoed as a
 * separate "system of record" (own key, own latency, own DB if desired).
 * Per-service variables override the global ones.
 */
function serviceConfig(name, defaults) {
  const U = name.toUpperCase();
  return {
    name,
    title: defaults.title,
    description: defaults.description,
    port: int(process.env[`${U}_PORT`], defaults.port),
    authMode: String(process.env[`${U}_AUTH_MODE`] || process.env.AUTH_MODE || 'apikey').toLowerCase(),
    apiKey: process.env[`${U}_API_KEY`] || defaults.apiKey,
    apiKeyHeader: String(process.env[`${U}_API_KEY_HEADER`] || 'x-api-key').toLowerCase(),
    databaseUrl: process.env[`${U}_DATABASE_URL`] || process.env.DATABASE_URL || DEFAULT_DB,
    latencyMs: int(process.env[`${U}_LATENCY_MS`], defaults.latencyMs || 0),
    errorRate: num(process.env[`${U}_ERROR_RATE`], 0),
    rateLimitMax: int(process.env[`${U}_RATE_LIMIT_MAX`], int(process.env.RATE_LIMIT_MAX, 300)),
    // Public URL of this backend as seen by the dashboard (only needed in separate mode behind tunnels)
    publicUrl: (process.env[`${U}_PUBLIC_URL`] || '').replace(/\/+$/, ''),
    demoApiKey: defaults.apiKey,
  };
}

const services = {
  erp: serviceConfig('erp', {
    title: 'ERP Purchasing API (mock)',
    description: 'Purchase orders, items, confirmations and inbound deliveries (SAP-style system of record)',
    port: 3001,
    apiKey: 'erp-demo-key',
  }),
  srm: serviceConfig('srm', {
    title: 'Supplier Master (SRM) API (mock)',
    description: 'Supplier master data, sites, contacts, ERP vendor cross-reference and consumer entitlements',
    port: 3002,
    apiKey: 'srm-demo-key',
  }),
  tms: serviceConfig('tms', {
    title: 'Logistics / TMS API (mock)',
    description: 'Advance shipment notices, carriers, milestones and tracking events',
    port: 3003,
    apiKey: 'tms-demo-key',
  }),
};

const enabled = String(process.env.ENABLED_SERVICES || 'erp,srm,tms')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter((s) => services[s]);

module.exports = {
  nodeEnv: process.env.NODE_ENV || 'development',
  apiVersion: process.env.API_VERSION || '1.0.0',
  serviceMode: String(process.env.SERVICE_MODE || 'combined').toLowerCase(), // combined | separate
  port: int(process.env.PORT, 3000),
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, ''),
  autoMigrate: bool(process.env.AUTO_MIGRATE, true),
  autoSeed: bool(process.env.AUTO_SEED, true),
  chaosEnabled: bool(process.env.CHAOS_ENABLED, true),
  rateLimitWindowMs: int(process.env.RATE_LIMIT_WINDOW_MS, 60000),
  logFormat: process.env.LOG_FORMAT || 'dev',
  dashboardEnabled: bool(process.env.DASHBOARD_ENABLED, true),
  // Let the dashboard pre-fill API keys, but only while they are still the published demo defaults
  dashboardPrefillDemoKeys: bool(process.env.DASHBOARD_PREFILL_DEMO_KEYS, true),
  services,
  enabledServices: enabled.length ? enabled : Object.keys(services),
};
