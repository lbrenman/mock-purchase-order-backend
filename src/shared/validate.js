'use strict';

const { ApiError } = require('./errors');

const pad = (n, w = 2) => String(n).padStart(w, '0');

/** Accepts 'YYYY-MM-DD' or 'YYYYMMDD'; returns 'YYYY-MM-DD' or null. */
function parseDateLoose(v) {
  if (typeof v !== 'string') return null;
  const m = v.match(/^(\d{4})-?(\d{2})-?(\d{2})$/);
  if (!m) return null;
  const [, y, mo, d] = m;
  const dt = new Date(Date.UTC(+y, +mo - 1, +d));
  if (dt.getUTCFullYear() !== +y || dt.getUTCMonth() !== +mo - 1 || dt.getUTCDate() !== +d) return null;
  return `${y}-${mo}-${d}`;
}

/** Accepts ISO-8601 / RFC 3339 or SAP 'YYYYMMDDhhmmss' (UTC); returns Date or null. */
function parseTimestampLoose(v) {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v !== 'string' || !v) return null;
  const sap = v.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  if (sap) {
    const [, y, mo, d, h, mi, s] = sap;
    const dt = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s));
    return Number.isNaN(dt.getTime()) ? null : dt;
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(v)) return null;
  const dt = new Date(v);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

const toSapDate = (isoDate) => (isoDate ? String(isoDate).replace(/-/g, '') : null);

function toSapTimestamp(date) {
  if (!date) return null;
  const d = new Date(date);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(
    d.getUTCMinutes()
  )}${pad(d.getUTCSeconds())}`;
}

const toIso = (date) => (date ? new Date(date).toISOString() : null);
const fixed = (v, digits) => (v === null || v === undefined ? null : Number(v).toFixed(digits));

/** Collects field errors, then throws one 400 with all violations. */
class Validator {
  constructor() {
    this.errors = [];
  }

  add(field, message) {
    this.errors.push({ field, message });
    return this;
  }

  present(obj, field, path = field) {
    const v = obj ? obj[field] : undefined;
    if (v === undefined || v === null || v === '') {
      this.add(path, 'is required');
      return false;
    }
    return true;
  }

  string(obj, field, { required = false, max, pattern, oneOf, path = field } = {}) {
    const v = obj ? obj[field] : undefined;
    if (v === undefined || v === null || v === '') {
      if (required) this.add(path, 'is required');
      return undefined;
    }
    if (typeof v !== 'string') return void this.add(path, 'must be a string');
    if (max && v.length > max) return void this.add(path, `must be at most ${max} characters`);
    if (pattern && !pattern.test(v)) return void this.add(path, `must match pattern ${pattern}`);
    if (oneOf && !oneOf.includes(v)) return void this.add(path, `must be one of: ${oneOf.join(', ')}`);
    return v;
  }

  number(obj, field, { required = false, min, exclusiveMin, integer = false, path = field } = {}) {
    const raw = obj ? obj[field] : undefined;
    if (raw === undefined || raw === null || raw === '') {
      if (required) this.add(path, 'is required');
      return undefined;
    }
    const v = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
    if (typeof v !== 'number' || !Number.isFinite(v)) return void this.add(path, 'must be a number');
    if (integer && !Number.isInteger(v)) return void this.add(path, 'must be an integer');
    if (min !== undefined && v < min) return void this.add(path, `must be >= ${min}`);
    if (exclusiveMin !== undefined && v <= exclusiveMin) return void this.add(path, `must be > ${exclusiveMin}`);
    return v;
  }

  boolean(obj, field, { required = false, path = field } = {}) {
    const v = obj ? obj[field] : undefined;
    if (v === undefined || v === null) {
      if (required) this.add(path, 'is required');
      return undefined;
    }
    if (typeof v !== 'boolean') return void this.add(path, 'must be a boolean');
    return v;
  }

  date(obj, field, { required = false, path = field } = {}) {
    const v = obj ? obj[field] : undefined;
    if (v === undefined || v === null || v === '') {
      if (required) this.add(path, 'is required');
      return undefined;
    }
    const parsed = parseDateLoose(v);
    if (!parsed) return void this.add(path, 'must be a date (YYYY-MM-DD or YYYYMMDD)');
    return parsed;
  }

  timestamp(obj, field, { required = false, path = field } = {}) {
    const v = obj ? obj[field] : undefined;
    if (v === undefined || v === null || v === '') {
      if (required) this.add(path, 'is required');
      return undefined;
    }
    const parsed = parseTimestampLoose(v);
    if (!parsed) return void this.add(path, 'must be an ISO-8601 date-time with offset');
    return parsed;
  }

  array(obj, field, { required = false, minItems = 0, path = field } = {}) {
    const v = obj ? obj[field] : undefined;
    if (v === undefined || v === null) {
      if (required) this.add(path, 'is required');
      return undefined;
    }
    if (!Array.isArray(v)) return void this.add(path, 'must be an array');
    if (v.length < minItems) return void this.add(path, `must contain at least ${minItems} item(s)`);
    return v;
  }

  object(obj, field, { required = false, path = field } = {}) {
    const v = obj ? obj[field] : undefined;
    if (v === undefined || v === null) {
      if (required) this.add(path, 'is required');
      return undefined;
    }
    if (typeof v !== 'object' || Array.isArray(v)) return void this.add(path, 'must be an object');
    return v;
  }

  throwIfErrors(message = 'Request validation failed') {
    if (this.errors.length) throw new ApiError(400, 'VALIDATION_FAILED', message, this.errors);
  }
}

/** Split 'a,b,c' (or repeated params) into a trimmed array. */
function csv(v) {
  if (v === undefined || v === null || v === '') return [];
  const arr = Array.isArray(v) ? v : [v];
  return arr
    .flatMap((x) => String(x).split(','))
    .map((s) => s.trim())
    .filter(Boolean);
}

function intParam(v, { def, min, max, name }) {
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || (max !== undefined && n > max)) {
    throw new ApiError(400, 'INVALID_QUERY_PARAMETER', `${name} must be an integer between ${min} and ${max}`, [
      { field: name, message: `must be an integer between ${min} and ${max}` },
    ]);
  }
  return n;
}

module.exports = {
  Validator,
  parseDateLoose,
  parseTimestampLoose,
  toSapDate,
  toSapTimestamp,
  toIso,
  fixed,
  csv,
  intParam,
};
