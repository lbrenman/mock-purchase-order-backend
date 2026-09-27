'use strict';

/**
 * Keeps the demo data current.
 *
 * The seed files in this folder were written around a fixed "today" (SEED_AS_OF). When the data is loaded,
 * every date and timestamp in it is moved forward by the time that has passed since then, in whole weeks, so
 * open orders are still open, in-transit shipments are still on their way, and nothing lands in the future.
 * All records move by the same amount, so the cross-system consistency of the seed is kept.
 *
 * The JSON files are never changed. Identifiers that contain a date (SHP-20260918-00121, ACK-...) are kept
 * as they are, because the Postman collection, the specs and docs/MAPPING.md refer to them.
 *
 * Environment:
 *   SEED_SHIFT=off          load the dates exactly as written (default: on)
 *   SEED_TODAY=2027-03-15   shift towards this day instead of the current date (rehearsals, tests)
 *
 * tools/dashboard-stub.py mirrors this logic; keep the two in step.
 */

const SEED_AS_OF = '2026-09-24T12:00:00Z';
const DAY_MS = 86400000;
const WEEK_DAYS = 7;

/** Every date or timestamp field in the seed files, by file and record path. */
const FIELDS = {
  erp: {
    purchase_orders: ['doc_date', 'delivery_date', 'created_at', 'changed_at', { items: ['confirmed_date'] }],
    confirmations: ['posted_at', { items: ['confirmed_date'] }],
    inbound_deliveries: ['posted_at', 'reversed_at'],
  },
  srm: {
    suppliers: ['onboarded_on'],
  },
  tms: {
    shipments: ['milestone_since', 'planned_ship_at', 'eta', 'created_at', 'updated_at', { events: ['occurred_at'] }],
  },
};

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const SAP_DATE = /^(\d{4})(\d{2})(\d{2})$/;
const ISO_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

function isOff(value) {
  return ['0', 'false', 'no', 'off'].includes(String(value || '').trim().toLowerCase());
}

/** Parses SEED_TODAY. A plain date means noon UTC, the same time of day as SEED_AS_OF. */
function parseToday(value) {
  const s = String(value).trim();
  const d = new Date(ISO_DATE.test(s) ? `${s}T12:00:00Z` : s);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`SEED_TODAY must be a date (YYYY-MM-DD) or an ISO-8601 timestamp, got "${value}"`);
  }
  return d;
}

/**
 * Number of days to add to every seed date: the time since SEED_AS_OF, rounded down to whole weeks so each
 * date keeps its weekday. Never negative, so the data is never moved back in time.
 */
function shiftDays({ env = process.env, now = new Date() } = {}) {
  if (isOff(env.SEED_SHIFT)) return 0;
  const today = env.SEED_TODAY ? parseToday(env.SEED_TODAY) : now;
  const elapsed = Math.floor((today.getTime() - Date.parse(SEED_AS_OF)) / DAY_MS);
  return elapsed > 0 ? Math.floor(elapsed / WEEK_DAYS) * WEEK_DAYS : 0;
}

const pad = (n) => String(n).padStart(2, '0');

/** Adds days to one value, keeping its format: YYYY-MM-DD, YYYYMMDD or an ISO-8601 UTC timestamp. */
function shiftValue(value, days) {
  if (!days || value === null || value === undefined || value === '') return value;
  if (typeof value !== 'string') return value;
  let m = value.match(ISO_DATE) || value.match(SAP_DATE);
  if (m) {
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]) + days * DAY_MS);
    const [y, mo, da] = [d.getUTCFullYear(), pad(d.getUTCMonth() + 1), pad(d.getUTCDate())];
    return value.includes('-') ? `${y}-${mo}-${da}` : `${y}${mo}${da}`;
  }
  if (ISO_TS.test(value)) {
    const iso = new Date(Date.parse(value) + days * DAY_MS).toISOString(); // always ends in .000Z
    return value.includes('.') ? iso : iso.replace(/\.\d{3}Z$/, 'Z');
  }
  throw new Error(`date-shift: unexpected date format "${value}"`);
}

function shiftRecord(record, spec, days) {
  for (const field of spec) {
    if (typeof field === 'string') {
      if (field in record) record[field] = shiftValue(record[field], days);
    } else {
      for (const [child, childSpec] of Object.entries(field)) {
        for (const row of record[child] || []) shiftRecord(row, childSpec, days);
      }
    }
  }
}

/** Returns a shifted deep copy of one seed file ('erp', 'srm' or 'tms'). The input is not modified. */
function shiftSeed(name, data, days) {
  const copy = JSON.parse(JSON.stringify(data));
  if (!days) return copy;
  for (const [collection, spec] of Object.entries(FIELDS[name] || {})) {
    for (const record of copy[collection] || []) shiftRecord(record, spec, days);
  }
  return copy;
}

module.exports = { SEED_AS_OF, FIELDS, shiftDays, shiftValue, shiftSeed };
