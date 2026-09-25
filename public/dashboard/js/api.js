// API client for the three backends.
// Every call is recorded in the wire log so the audience can see which system answered and in what dialect.

const STORE_KEY = 'po-backends-dashboard:connections';
const listeners = new Set();
const log = [];
let seq = 0;

export const services = {};
export let serverConfig = { mode: 'combined', chaosEnabled: false, services: [] };

export class ApiError extends Error {
  constructor(status, code, message, details, raw) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details || [];
    this.raw = raw;
  }
}

/** Loads /dashboard/config.json and applies any browser-side overrides from Settings. */
export async function loadConfig() {
  try {
    const res = await fetch('config.json', { cache: 'no-store' });
    if (res.ok) serverConfig = await res.json();
  } catch {
    /* dashboard opened from a file or a static host: fall back to same-origin defaults */
  }
  if (!serverConfig.services || !serverConfig.services.length) {
    serverConfig.services = ['erp', 'srm', 'tms'].map((name) => ({
      name, title: name.toUpperCase(), baseUrl: `/${name}`, authMode: 'apikey', apiKeyHeader: 'x-api-key', apiKey: `${name}-demo-key`,
    }));
  }
  const saved = readOverrides();
  for (const s of serverConfig.services) {
    const o = saved[s.name] || {};
    services[s.name] = {
      name: s.name,
      title: s.title,
      description: s.description,
      baseUrl: (o.baseUrl || s.baseUrl).replace(/\/+$/, ''),
      apiKey: o.apiKey !== undefined ? o.apiKey : s.apiKey || '',
      apiKeyHeader: o.apiKeyHeader || s.apiKeyHeader || 'x-api-key',
      authMode: s.authMode,
      defaults: { baseUrl: s.baseUrl, apiKey: s.apiKey || '', apiKeyHeader: s.apiKeyHeader || 'x-api-key' },
    };
  }
}

function readOverrides() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
  } catch {
    return {};
  }
}

export function saveOverrides(values) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(values));
  } catch {
    /* storage unavailable: settings last for this session only */
  }
  for (const [name, v] of Object.entries(values)) {
    if (!services[name]) continue;
    Object.assign(services[name], { baseUrl: v.baseUrl.replace(/\/+$/, ''), apiKey: v.apiKey, apiKeyHeader: v.apiKeyHeader });
  }
}

export function clearOverrides() {
  try {
    localStorage.removeItem(STORE_KEY);
  } catch {
    /* ignore */
  }
  for (const s of Object.values(services)) Object.assign(s, s.defaults);
}

export const isEnabled = (name) => Boolean(services[name]);

function qs(query) {
  if (!query) return '';
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue;
    p.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

/** Normalises the three error dialects into one shape for the UI. */
function normalizeError(svc, status, body) {
  if (body && typeof body === 'object') {
    if (svc === 'erp' && body.error) {
      const e = body.error;
      return new ApiError(status, e.code, e.message, (e.details || []).map((d) => ({ field: d.field, message: d.message })), body);
    }
    if (svc === 'srm' && Array.isArray(body.errors)) {
      const [first] = body.errors;
      const details = body.errors.filter((x) => x.field).map((x) => ({ field: x.field, message: x.message }));
      return new ApiError(status, first && first.code, first ? first.message : 'Request failed', details, body);
    }
    if (svc === 'tms' && body.fault) {
      const f = body.fault;
      return new ApiError(status, String(f.faultCode || '').replace(/^tms\./, ''), f.faultString,
        (f.detail || []).map((d) => ({ field: d.path, message: d.issue })), body);
    }
    if (body.error && typeof body.error === 'string') return new ApiError(status, 'ERROR', body.error, [], body);
  }
  const text = typeof body === 'string' && body ? body.slice(0, 200) : `HTTP ${status}`;
  return new ApiError(status, `HTTP_${status}`, text, [], body);
}

/**
 * call('erp', 'GET', '/v1/purchase-orders', { query, body, headers })
 * Resolves with { status, data, headers, ms } or throws ApiError.
 */
export async function call(svc, method, path, { query, body, headers = {}, quiet = false } = {}) {
  const s = services[svc];
  if (!s) throw new ApiError(0, 'SERVICE_DISABLED', `The ${svc.toUpperCase()} backend is not enabled on this server.`);
  const url = `${s.baseUrl}${path}${qs(query)}`;
  const reqHeaders = { accept: 'application/json', 'x-correlation-id': `dash-${Date.now().toString(36)}-${(++seq).toString(36)}`, 'ngrok-skip-browser-warning': 'true', ...headers };
  if (s.apiKey) reqHeaders[s.apiKeyHeader] = s.apiKey;
  if (body !== undefined) reqHeaders['content-type'] = 'application/json';
  if (['POST', 'PUT', 'PATCH'].includes(method) && !Object.keys(reqHeaders).some((k) => k.toLowerCase() === 'idempotency-key')) {
    if (method === 'POST') reqHeaders['Idempotency-Key'] = `dash-${crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + seq}`;
  }
  const entry = {
    id: seq, svc, method, path: `${path}${qs(query)}`, url, at: new Date(), status: null, ms: null,
    request: body, response: null, correlationId: reqHeaders['x-correlation-id'], quiet,
    headers: Object.fromEntries(Object.entries(reqHeaders)
      .filter(([k]) => !['accept', 'ngrok-skip-browser-warning', 'content-type'].includes(k.toLowerCase()))
      .map(([k, v]) => [k, k === s.apiKeyHeader ? `${String(v).slice(0, 4)}…` : v])),
  };
  const started = performance.now();
  let res;
  try {
    res = await fetch(url, { method, headers: reqHeaders, body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch (err) {
    entry.status = 'ERR';
    entry.ms = Math.round(performance.now() - started);
    entry.response = { networkError: err.message };
    push(entry);
    throw new ApiError(0, 'NETWORK_ERROR', `Could not reach the ${svc.toUpperCase()} backend at ${s.baseUrl}. Check the connection settings.`);
  }
  entry.ms = Math.round(performance.now() - started);
  entry.status = res.status;
  const text = res.status === 204 ? '' : await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  entry.response = data;
  push(entry);
  if (!res.ok) throw normalizeError(svc, res.status, data);
  return { status: res.status, data, headers: res.headers, ms: entry.ms };
}

function push(entry) {
  log.unshift(entry);
  if (log.length > 250) log.length = 250;
  listeners.forEach((fn) => fn(log, entry));
}

export const onLog = (fn) => listeners.add(fn);
export const getLog = () => log;
export const clearLog = () => {
  log.length = 0;
  listeners.forEach((fn) => fn(log, null));
};

// ── Convenience wrappers ─────────────────────────────────────────────────
export const get = (svc, path, query, opts = {}) => call(svc, 'GET', path, { query, ...opts }).then((r) => r.data);
export const post = (svc, path, body, opts = {}) => call(svc, 'POST', path, { body: body ?? {}, ...opts }).then((r) => r.data);
export const patch = (svc, path, body, opts = {}) => call(svc, 'PATCH', path, { body, ...opts }).then((r) => r.data);
export const del = (svc, path, opts = {}) => call(svc, 'DELETE', path, opts).then((r) => r.data);

/** Fetch every page of an ERP list ({data, pagination}). */
export async function erpAll(path, query = {}, max = 1000) {
  const out = [];
  for (let page = 1; out.length < max; page += 1) {
    const r = await get('erp', path, { ...query, page, limit: 200 }, { quiet: true });
    out.push(...r.data);
    if (!r.pagination || !r.pagination.hasNext) break;
  }
  return out;
}

/** Fetch every page of an SRM list ({total, offset, limit, items}). */
export async function srmAll(path, query = {}, pageSize = 100) {
  const out = [];
  for (let offset = 0; ; offset += pageSize) {
    const r = await get('srm', path, { ...query, offset, limit: pageSize }, { quiet: true });
    out.push(...r.items);
    if (r.total === undefined || out.length >= r.total || !r.items.length) break;
  }
  return out;
}

/** Fetch every page of a TMS list ({count, results, nextCursor}). */
export async function tmsAll(path, query = {}, max = 1000) {
  const out = [];
  let cursor;
  do {
    const r = await get('tms', path, { ...query, limit: 200, cursor }, { quiet: true });
    out.push(...r.results);
    cursor = r.nextCursor;
  } while (cursor && out.length < max);
  return out;
}
