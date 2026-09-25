'use strict';

const express = require('express');
const { ApiError, asyncHandler } = require('../../shared/errors');
const { withTransaction } = require('../../shared/db');
const { Validator, csv, intParam, toIso, parseTimestampLoose } = require('../../shared/validate');

const MILESTONES = {
  PLN: 'Planned - ASN drafted, not yet tendered',
  TND: 'Tendered - ASN submitted to carrier',
  ITR: 'In transit',
  DLV: 'Delivered',
  EXC: 'Exception - delayed or on hold',
  CXL: 'Cancelled',
};
const EVENT_CODES = {
  PU: { milestone: 'ITR', description: 'Picked up by carrier' },
  DEP: { milestone: 'ITR', description: 'Departed facility' },
  ARR: { milestone: 'ITR', description: 'Arrived at facility' },
  OFD: { milestone: 'ITR', description: 'Out for delivery' },
  RES: { milestone: 'ITR', description: 'Exception resolved - movement resumed' },
  DLV: { milestone: 'DLV', description: 'Delivered' },
  EXC: { milestone: 'EXC', description: 'Exception - shipment delayed' },
};
const HU_TYPES = ['PLT', 'CTN', 'CRT', 'OTH'];
const CLOSED = ['DLV', 'CXL'];
const SUPPLIER_RE = /^SUP-[0-9]{6}$/;
const PO_RE = /^[0-9]{10}$/;
const SHIPMENT_RE = /^SHP-[0-9]{8}-[0-9]{5}$/;

const SELECT_SHIPMENT = `
  SELECT s.*, c.name AS carrier_name, c.carrier_code, c.tracking_url_template
    FROM tms.shipments s JOIN tms.carriers c ON c.scac = s.carrier_scac`;

// ─── Mappers (DB row -> TMS wire format) ─────────────────────────────────
const mapEvent = (e) => ({
  eventId: e.event_id,
  code: e.event_code,
  description: e.description,
  location: e.location,
  occurredAt: toIso(e.occurred_at),
  recordedAt: toIso(e.recorded_at),
});

function mapShipment(s, events) {
  const out = {
    shipmentId: s.shipment_id,
    asnNumber: s.asn_number,
    supplierCode: s.supplier_code,
    carrier: {
      scac: s.carrier_scac,
      carrierCode: s.carrier_code,
      name: s.carrier_name,
      trackingId: s.tracking_id,
      trackingUrl: s.tracking_url_template && s.tracking_id ? s.tracking_url_template.replace('{trackingId}', s.tracking_id) : null,
    },
    milestone: { code: s.milestone, description: MILESTONES[s.milestone], since: toIso(s.milestone_since) },
    route: { origin: s.origin, destination: s.destination },
    schedule: { plannedShipDate: toIso(s.planned_ship_at), estimatedArrival: toIso(s.eta) },
    contents: s.contents,
    handlingUnits: s.handling_units,
    cancelReason: s.cancel_reason,
    audit: { createdAt: toIso(s.created_at), updatedAt: toIso(s.updated_at) },
  };
  if (events) out.events = events.map(mapEvent);
  return out;
}

const encodeCursor = (id) => Buffer.from(id, 'utf8').toString('base64url');
function decodeCursor(c) {
  const id = Buffer.from(String(c), 'base64url').toString('utf8');
  if (!SHIPMENT_RE.test(id)) {
    throw new ApiError(400, 'INVALID_CURSOR', 'cursor is not valid', [{ field: 'cursor', message: 'use nextCursor from a previous page' }]);
  }
  return id;
}

function validateLocation(v, loc, path) {
  if (!v.object({ loc }, 'loc', { required: true, path })) return null;
  return {
    locationCode: v.string(loc, 'locationCode', { required: true, max: 40, path: `${path}.locationCode` }),
    name: v.string(loc, 'name', { required: true, max: 120, path: `${path}.name` }),
    street: v.string(loc, 'street', { max: 120, path: `${path}.street` }) || null,
    city: v.string(loc, 'city', { max: 80, path: `${path}.city` }) || null,
    state: v.string(loc, 'state', { max: 80, path: `${path}.state` }) || null,
    zip: v.string(loc, 'zip', { max: 20, path: `${path}.zip` }) || null,
    country: v.string(loc, 'country', { required: true, pattern: /^[A-Z]{2}$/, path: `${path}.country` }),
  };
}

module.exports = function buildTmsRoutes({ pool, idem }) {
  const r = express.Router();

  async function loadShipment(db, id, { lock = false } = {}) {
    if (!SHIPMENT_RE.test(id)) {
      throw new ApiError(400, 'INVALID_SHIPMENT_ID', 'Shipment ids look like SHP-YYYYMMDD-NNNNN', [
        { field: 'shipmentId', message: 'must match ^SHP-[0-9]{8}-[0-9]{5}$' },
      ]);
    }
    const sql = lock ? 'SELECT * FROM tms.shipments WHERE shipment_id = $1 FOR UPDATE' : `${SELECT_SHIPMENT} WHERE s.shipment_id = $1`;
    const { rows } = await db.query(sql, [id]);
    if (!rows[0]) throw new ApiError(404, 'SHIPMENT_NOT_FOUND', `Shipment ${id} does not exist`);
    return rows[0];
  }

  const loadEvents = async (db, id) =>
    (await db.query('SELECT * FROM tms.tracking_events WHERE shipment_id = $1 ORDER BY occurred_at, event_id', [id])).rows;

  // ─── Reference data ──────────────────────────────────────────────────────
  r.get(
    '/carriers',
    asyncHandler(async (req, res) => {
      const params = [];
      const conds = [];
      const codes = csv(req.query.code);
      if (codes.length) {
        params.push(codes.map((c) => c.toUpperCase()));
        conds.push(`carrier_code = ANY($${params.length})`);
      }
      const scacs = csv(req.query.scac);
      if (scacs.length) {
        params.push(scacs.map((c) => c.toUpperCase()));
        conds.push(`scac = ANY($${params.length})`);
      }
      const { rows } = await pool.query(
        `SELECT * FROM tms.carriers ${conds.length ? `WHERE ${conds.join(' AND ')}` : ''} ORDER BY carrier_code`,
        params
      );
      res.json({
        count: rows.length,
        results: rows.map((c) => ({
          carrierCode: c.carrier_code,
          scac: c.scac,
          name: c.name,
          mode: c.mode,
          trackingUrlTemplate: c.tracking_url_template,
        })),
      });
    })
  );

  r.get('/milestones', (req, res) => {
    res.json({ count: 6, results: Object.entries(MILESTONES).map(([code, description]) => ({ code, description })) });
  });

  r.get('/event-codes', (req, res) => {
    const results = Object.entries(EVENT_CODES).map(([code, e]) => ({ code, description: e.description, resultingMilestone: e.milestone }));
    res.json({ count: results.length, results });
  });

  // ─── Shipments ───────────────────────────────────────────────────────────
  r.get(
    '/shipments',
    asyncHandler(async (req, res) => {
      const limit = intParam(req.query.limit, { def: 25, min: 1, max: 200, name: 'limit' });
      const conds = [];
      const params = [];
      const add = (sql, val) => {
        params.push(val);
        conds.push(sql.replace('?', `$${params.length}`));
      };
      const suppliers = csv(req.query.supplierCode);
      if (suppliers.length) add('s.supplier_code = ANY(?)', suppliers);
      const statuses = csv(req.query.status);
      if (statuses.some((x) => !MILESTONES[x])) {
        throw new ApiError(400, 'INVALID_FILTER', `status must be milestone codes: ${Object.keys(MILESTONES).join(', ')}`, [
          { field: 'status', message: 'invalid milestone code' },
        ]);
      }
      if (statuses.length) add('s.milestone = ANY(?)', statuses);
      if (req.query.poNumber) {
        if (!PO_RE.test(String(req.query.poNumber))) {
          throw new ApiError(400, 'INVALID_FILTER', 'poNumber must be a 10-digit ERP PO number', [{ field: 'poNumber', message: 'must match ^[0-9]{10}$' }]);
        }
        add('s.contents @> ?::jsonb', JSON.stringify([{ poNumber: String(req.query.poNumber) }]));
      }
      if (req.query.asnNumber) add('s.asn_number = ?', String(req.query.asnNumber));
      const scacs = csv(req.query.carrier).map((x) => x.toUpperCase());
      if (scacs.length) add('(s.carrier_scac = ANY(?) OR c.carrier_code = ANY($' + (params.length + 1) + '))', scacs);
      if (req.query.updatedSince) {
        const ts = parseTimestampLoose(String(req.query.updatedSince));
        if (!ts) throw new ApiError(400, 'INVALID_FILTER', 'updatedSince must be ISO-8601', [{ field: 'updatedSince', message: 'invalid date-time' }]);
        add('s.updated_at >= ?', ts);
      }
      if (req.query.cursor) add('s.shipment_id < ?', decodeCursor(req.query.cursor));

      const { rows } = await pool.query(
        `${SELECT_SHIPMENT} ${conds.length ? `WHERE ${conds.join(' AND ')}` : ''}
          ORDER BY s.shipment_id DESC LIMIT ${limit + 1}`,
        params
      );
      const hasMore = rows.length > limit;
      const page = rows.slice(0, limit);
      res.json({
        count: page.length,
        results: page.map((s) => mapShipment(s)),
        nextCursor: hasMore ? encodeCursor(page[page.length - 1].shipment_id) : null,
      });
    })
  );

  r.post(
    '/shipments',
    idem,
    asyncHandler(async (req, res) => {
      const b = req.body || {};
      const v = new Validator();
      const asnNumber = v.string(b, 'asnNumber', { required: true, max: 80 });
      const supplierCode = v.string(b, 'supplierCode', { required: true, pattern: SUPPLIER_RE });
      const carrier = v.object(b, 'carrier', { required: true }) || {};
      const scac = v.string(carrier, 'scac', { required: true, max: 4, path: 'carrier.scac' });
      const trackingId = v.string(carrier, 'trackingId', { max: 100, path: 'carrier.trackingId' });
      const route = v.object(b, 'route', { required: true }) || {};
      const hasRoute = b.route && typeof b.route === 'object';
      const origin = hasRoute ? validateLocation(v, route.origin, 'route.origin') : null;
      const destination = hasRoute ? validateLocation(v, route.destination, 'route.destination') : null;
      const schedule = v.object(b, 'schedule', { required: true }) || {};
      const planned = v.timestamp(schedule, 'plannedShipDate', { required: true, path: 'schedule.plannedShipDate' });
      const eta = v.timestamp(schedule, 'estimatedArrival', { required: true, path: 'schedule.estimatedArrival' });
      const contentsIn = v.array(b, 'contents', { required: true, minItems: 1 }) || [];
      const contents = contentsIn.map((c, i) => {
        const p = `contents[${i}]`;
        const qty = v.object(c, 'quantity', { required: true, path: `${p}.quantity` }) || {};
        return {
          poNumber: v.string(c, 'poNumber', { required: true, pattern: PO_RE, path: `${p}.poNumber` }),
          poLine: v.number(c, 'poLine', { required: true, min: 1, integer: true, path: `${p}.poLine` }),
          quantity: {
            value: v.number(qty, 'value', { required: true, exclusiveMin: 0, path: `${p}.quantity.value` }),
            uom: v.string(qty, 'uom', { required: true, max: 12, path: `${p}.quantity.uom` }),
          },
          lotNumber: v.string(c, 'lotNumber', { max: 80, path: `${p}.lotNumber` }) || null,
        };
      });
      const husIn = v.array(b, 'handlingUnits') || [];
      const handlingUnits = husIn.map((h, i) => {
        const p = `handlingUnits[${i}]`;
        const w = v.object(h, 'weight', { path: `${p}.weight` });
        return {
          huId: v.string(h, 'huId', { required: true, max: 80, path: `${p}.huId` }),
          type: v.string(h, 'type', { required: true, oneOf: HU_TYPES, path: `${p}.type` }),
          weight: w
            ? {
                value: v.number(w, 'value', { required: true, min: 0, path: `${p}.weight.value` }),
                unit: v.string(w, 'unit', { required: true, oneOf: ['kg', 'lb'], path: `${p}.weight.unit` }),
              }
            : null,
        };
      });
      const tender = v.boolean(b, 'tender');
      v.throwIfErrors();

      if (eta < planned) {
        throw new ApiError(422, 'INVALID_SCHEDULE', 'estimatedArrival must not be before plannedShipDate', [
          { field: 'schedule.estimatedArrival', message: 'must be >= schedule.plannedShipDate' },
        ]);
      }

      const created = await withTransaction(pool, async (c) => {
        const car = await c.query('SELECT scac FROM tms.carriers WHERE scac = $1', [scac.toUpperCase()]);
        if (!car.rows[0]) {
          throw new ApiError(422, 'UNKNOWN_CARRIER', `Carrier SCAC ${scac} is not configured in TMS (see GET /tms/v1/carriers)`, [
            { field: 'carrier.scac', message: 'unknown SCAC' },
          ]);
        }
        const dup = await c.query('SELECT shipment_id FROM tms.shipments WHERE supplier_code = $1 AND asn_number = $2', [
          supplierCode,
          asnNumber,
        ]);
        if (dup.rows[0]) {
          throw new ApiError(409, 'DUPLICATE_ASN', `ASN ${asnNumber} already exists for ${supplierCode} as ${dup.rows[0].shipment_id}`);
        }
        const seq = await c.query("SELECT nextval('tms.shipment_seq') AS n");
        const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        const id = `SHP-${day}-${String(seq.rows[0].n).padStart(5, '0')}`;
        const milestone = tender === false ? 'PLN' : 'TND';
        await c.query(
          `INSERT INTO tms.shipments (shipment_id, asn_number, supplier_code, carrier_scac, tracking_id, milestone,
              origin, destination, planned_ship_at, eta, contents, handling_units)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [id, asnNumber, supplierCode, scac.toUpperCase(), trackingId || null, milestone, JSON.stringify(origin),
            JSON.stringify(destination), planned, eta, JSON.stringify(contents), JSON.stringify(handlingUnits)]
        );
        if (milestone === 'TND') {
          await c.query(
            "INSERT INTO tms.tracking_events (shipment_id, event_code, description, occurred_at) VALUES ($1,'TND','ASN received and tendered to carrier',NOW())",
            [id]
          );
        }
        return id;
      });

      const s = await loadShipment(pool, created);
      res.status(201).set('Location', `/tms/v1/shipments/${created}`).json(mapShipment(s));
    })
  );

  r.get(
    '/shipments/:shipmentId',
    asyncHandler(async (req, res) => {
      const s = await loadShipment(pool, req.params.shipmentId);
      const events = csv(req.query.include).includes('events') ? await loadEvents(pool, s.shipment_id) : undefined;
      res.json(mapShipment(s, events));
    })
  );

  r.get(
    '/shipments/:shipmentId/events',
    asyncHandler(async (req, res) => {
      const s = await loadShipment(pool, req.params.shipmentId);
      const events = await loadEvents(pool, s.shipment_id);
      res.json({ shipmentId: s.shipment_id, milestone: s.milestone, count: events.length, results: events.map(mapEvent) });
    })
  );

  /** Demo control: move a shipment along (PU/DEP/ARR/OFD/RES -> ITR, EXC -> EXC, DLV -> DLV). */
  r.post(
    '/shipments/:shipmentId/events',
    idem,
    asyncHandler(async (req, res) => {
      const b = req.body || {};
      const v = new Validator();
      const code = v.string(b, 'eventCode', { required: true, oneOf: Object.keys(EVENT_CODES) });
      const description = v.string(b, 'description', { max: 240 });
      const location = v.string(b, 'location', { max: 120 });
      const occurredAt = v.timestamp(b, 'occurredAt') || new Date();
      const newEta = v.timestamp(b, 'newEstimatedArrival');
      v.throwIfErrors();

      await withTransaction(pool, async (c) => {
        const s = await loadShipment(c, req.params.shipmentId, { lock: true });
        if (s.milestone === 'PLN') throw new ApiError(409, 'NOT_TENDERED', 'Shipment is still planned; tender it before posting tracking events');
        if (CLOSED.includes(s.milestone)) throw new ApiError(409, 'SHIPMENT_CLOSED', `Shipment is ${MILESTONES[s.milestone].toLowerCase()}`);
        await c.query(
          'INSERT INTO tms.tracking_events (shipment_id, event_code, description, location, occurred_at) VALUES ($1,$2,$3,$4,$5)',
          [s.shipment_id, code, description || EVENT_CODES[code].description, location || null, occurredAt]
        );
        const next = EVENT_CODES[code].milestone;
        await c.query(
          `UPDATE tms.shipments SET
              milestone = $2,
              milestone_since = CASE WHEN milestone = $2 THEN milestone_since ELSE $3::timestamptz END,
              eta = COALESCE($4::timestamptz, eta),
              updated_at = NOW()
            WHERE shipment_id = $1`,
          [s.shipment_id, next, occurredAt, newEta || null]
        );
      });

      const s = await loadShipment(pool, req.params.shipmentId);
      res.status(201).json(mapShipment(s, await loadEvents(pool, s.shipment_id)));
    })
  );

  r.post(
    '/shipments/:shipmentId/tender',
    idem,
    asyncHandler(async (req, res) => {
      await withTransaction(pool, async (c) => {
        const s = await loadShipment(c, req.params.shipmentId, { lock: true });
        if (s.milestone !== 'PLN') throw new ApiError(409, 'ALREADY_TENDERED', `Shipment milestone is ${s.milestone}; only PLN can be tendered`);
        await c.query("UPDATE tms.shipments SET milestone = 'TND', milestone_since = NOW(), updated_at = NOW() WHERE shipment_id = $1", [s.shipment_id]);
        await c.query(
          "INSERT INTO tms.tracking_events (shipment_id, event_code, description, occurred_at) VALUES ($1,'TND','ASN tendered to carrier',NOW())",
          [s.shipment_id]
        );
      });
      const s = await loadShipment(pool, req.params.shipmentId);
      res.json(mapShipment(s));
    })
  );

  /** Compensation / business cancel. */
  r.post(
    '/shipments/:shipmentId/cancel',
    idem,
    asyncHandler(async (req, res) => {
      const v = new Validator();
      const reason = v.string(req.body || {}, 'reason', { max: 240 }) || 'Cancelled by request';
      v.throwIfErrors();
      await withTransaction(pool, async (c) => {
        const s = await loadShipment(c, req.params.shipmentId, { lock: true });
        if (CLOSED.includes(s.milestone)) throw new ApiError(409, 'SHIPMENT_CLOSED', `Shipment is ${MILESTONES[s.milestone].toLowerCase()} and cannot be cancelled`);
        await c.query(
          "UPDATE tms.shipments SET milestone = 'CXL', milestone_since = NOW(), cancel_reason = $2, updated_at = NOW() WHERE shipment_id = $1",
          [s.shipment_id, reason]
        );
        await c.query(
          "INSERT INTO tms.tracking_events (shipment_id, event_code, description, occurred_at) VALUES ($1,'CXL',$2,NOW())",
          [s.shipment_id, `Cancelled: ${reason}`]
        );
      });
      const s = await loadShipment(pool, req.params.shipmentId);
      res.json(mapShipment(s));
    })
  );


  // ═══ Maintenance (CRUD) endpoints used by the dashboard and Postman ═══════

  // ─── Carriers ────────────────────────────────────────────────────────────
  const MODES = ['PARCEL', 'LTL', 'FTL', 'AIR', 'OCEAN'];
  const mapCarrier = (c) => ({ carrierCode: c.carrier_code, scac: c.scac, name: c.name, mode: c.mode, trackingUrlTemplate: c.tracking_url_template });
  async function loadCarrier(code) {
    const { rows } = await pool.query('SELECT * FROM tms.carriers WHERE carrier_code = $1 OR scac = $1', [String(code).toUpperCase()]);
    if (!rows[0]) throw new ApiError(404, 'CARRIER_NOT_FOUND', `Carrier ${code} is not configured`);
    return rows[0];
  }

  r.get(
    '/carriers/:carrierCode',
    asyncHandler(async (req, res) => {
      const c = await loadCarrier(req.params.carrierCode);
      const { rows } = await pool.query(
        'SELECT milestone, COUNT(*)::int AS n FROM tms.shipments WHERE carrier_scac = $1 GROUP BY milestone',
        [c.scac]
      );
      res.json({ ...mapCarrier(c), shipmentsByMilestone: Object.fromEntries(rows.map((x) => [x.milestone, x.n])) });
    })
  );

  r.post(
    '/carriers',
    idem,
    asyncHandler(async (req, res) => {
      const b = req.body || {};
      const v = new Validator();
      const code = v.string(b, 'carrierCode', { required: true, max: 20, pattern: /^[A-Z0-9]+$/ });
      const scac = v.string(b, 'scac', { required: true, pattern: /^[A-Z]{2,4}$/ });
      const name = v.string(b, 'name', { required: true, max: 120 });
      const mode = v.string(b, 'mode', { required: true, oneOf: MODES });
      const tpl = v.string(b, 'trackingUrlTemplate', { max: 300 });
      v.throwIfErrors();
      await pool.query(
        'INSERT INTO tms.carriers (carrier_code, scac, name, mode, tracking_url_template) VALUES ($1,$2,$3,$4,$5)',
        [code, scac, name, mode, tpl || null]
      );
      res.status(201).set('Location', `/tms/v1/carriers/${code}`).json(mapCarrier(await loadCarrier(code)));
    })
  );

  r.patch(
    '/carriers/:carrierCode',
    asyncHandler(async (req, res) => {
      const b = req.body || {};
      const v = new Validator();
      const name = v.string(b, 'name', { max: 120 });
      const mode = v.string(b, 'mode', { oneOf: MODES });
      const tpl = v.string(b, 'trackingUrlTemplate', { max: 300 });
      if (!name && !mode && tpl === undefined && b.trackingUrlTemplate !== null) v.add('body', 'provide name, mode and/or trackingUrlTemplate');
      v.throwIfErrors();
      const c = await loadCarrier(req.params.carrierCode);
      await pool.query(
        `UPDATE tms.carriers SET name = COALESCE($2, name), mode = COALESCE($3, mode),
            tracking_url_template = CASE WHEN $4::boolean THEN NULL ELSE COALESCE($5, tracking_url_template) END
          WHERE carrier_code = $1`,
        [c.carrier_code, name || null, mode || null, b.trackingUrlTemplate === null, tpl || null]
      );
      res.json(mapCarrier(await loadCarrier(c.carrier_code)));
    })
  );

  r.delete(
    '/carriers/:carrierCode',
    asyncHandler(async (req, res) => {
      const c = await loadCarrier(req.params.carrierCode);
      const used = await pool.query('SELECT COUNT(*)::int AS n FROM tms.shipments WHERE carrier_scac = $1', [c.scac]);
      if (used.rows[0].n) {
        throw new ApiError(409, 'CARRIER_IN_USE', `Carrier ${c.carrier_code} (${c.scac}) is used by ${used.rows[0].n} shipment(s)`);
      }
      await pool.query('DELETE FROM tms.carriers WHERE carrier_code = $1', [c.carrier_code]);
      res.status(204).end();
    })
  );

  // ─── Shipment update / delete ────────────────────────────────────────────
  /**
   * PATCH rules (mirrors a real TMS):
   *  - any open shipment (not DLV/CXL): trackingId, schedule.estimatedArrival
   *  - PLN or TND only: carrier.scac, route, schedule.plannedShipDate, handlingUnits
   *  - PLN only: contents, asnNumber
   */
  r.patch(
    '/shipments/:shipmentId',
    asyncHandler(async (req, res) => {
      const b = req.body || {};
      const v = new Validator();
      const carrier = v.object(b, 'carrier') || {};
      const scac = v.string(carrier, 'scac', { max: 4, path: 'carrier.scac' });
      const trackingId = v.string(carrier, 'trackingId', { max: 100, path: 'carrier.trackingId' });
      const schedule = v.object(b, 'schedule') || {};
      const planned = v.timestamp(schedule, 'plannedShipDate', { path: 'schedule.plannedShipDate' });
      const eta = v.timestamp(schedule, 'estimatedArrival', { path: 'schedule.estimatedArrival' });
      const asnNumber = v.string(b, 'asnNumber', { max: 80 });
      const route = v.object(b, 'route');
      const origin = route && route.origin ? validateLocation(v, route.origin, 'route.origin') : null;
      const destination = route && route.destination ? validateLocation(v, route.destination, 'route.destination') : null;
      const contentsIn = v.array(b, 'contents', { minItems: 1 });
      const contents = contentsIn
        ? contentsIn.map((c, i) => {
            const p = `contents[${i}]`;
            const qty = v.object(c, 'quantity', { required: true, path: `${p}.quantity` }) || {};
            return {
              poNumber: v.string(c, 'poNumber', { required: true, pattern: PO_RE, path: `${p}.poNumber` }),
              poLine: v.number(c, 'poLine', { required: true, min: 1, integer: true, path: `${p}.poLine` }),
              quantity: {
                value: v.number(qty, 'value', { required: true, exclusiveMin: 0, path: `${p}.quantity.value` }),
                uom: v.string(qty, 'uom', { required: true, max: 12, path: `${p}.quantity.uom` }),
              },
              lotNumber: v.string(c, 'lotNumber', { max: 80, path: `${p}.lotNumber` }) || null,
            };
          })
        : null;
      const husIn = v.array(b, 'handlingUnits');
      const hus = husIn
        ? husIn.map((h, i) => {
            const p = `handlingUnits[${i}]`;
            const w = v.object(h, 'weight', { path: `${p}.weight` });
            return {
              huId: v.string(h, 'huId', { required: true, max: 80, path: `${p}.huId` }),
              type: v.string(h, 'type', { required: true, oneOf: HU_TYPES, path: `${p}.type` }),
              weight: w
                ? {
                    value: v.number(w, 'value', { required: true, min: 0, path: `${p}.weight.value` }),
                    unit: v.string(w, 'unit', { required: true, oneOf: ['kg', 'lb'], path: `${p}.weight.unit` }),
                  }
                : null,
            };
          })
        : null;
      const changes = [scac, trackingId, planned, eta, asnNumber, origin, destination, contents, hus].filter((x) => x !== undefined && x !== null);
      if (!changes.length) v.add('body', 'provide at least one updatable field');
      v.throwIfErrors();

      await withTransaction(pool, async (c) => {
        const s = await loadShipment(c, req.params.shipmentId, { lock: true });
        if (CLOSED.includes(s.milestone)) throw new ApiError(409, 'SHIPMENT_CLOSED', `Shipment is ${MILESTONES[s.milestone].toLowerCase()} and cannot be changed`);
        const early = ['PLN', 'TND'].includes(s.milestone);
        const locked = [];
        if (!early && (scac || origin || destination || planned || hus)) locked.push('carrier.scac, route, schedule.plannedShipDate, handlingUnits');
        if (s.milestone !== 'PLN' && (contents || asnNumber)) locked.push('contents, asnNumber');
        if (locked.length) {
          throw new ApiError(409, 'FIELD_LOCKED', `Shipment is ${MILESTONES[s.milestone].toLowerCase()}; these fields can no longer change: ${locked.join('; ')}`);
        }
        if (scac) {
          const car = await c.query('SELECT scac FROM tms.carriers WHERE scac = $1', [scac.toUpperCase()]);
          if (!car.rows[0]) throw new ApiError(422, 'UNKNOWN_CARRIER', `Carrier SCAC ${scac} is not configured in TMS`, [{ field: 'carrier.scac', message: 'unknown SCAC' }]);
        }
        const newPlanned = planned || s.planned_ship_at;
        const newEta = eta || s.eta;
        if (new Date(newEta) < new Date(newPlanned)) {
          throw new ApiError(422, 'INVALID_SCHEDULE', 'estimatedArrival must not be before plannedShipDate', [
            { field: 'schedule.estimatedArrival', message: 'must be >= schedule.plannedShipDate' },
          ]);
        }
        await c.query(
          `UPDATE tms.shipments SET carrier_scac = COALESCE($2, carrier_scac), tracking_id = COALESCE($3, tracking_id),
              planned_ship_at = $4, eta = $5, asn_number = COALESCE($6, asn_number),
              origin = COALESCE($7::jsonb, origin), destination = COALESCE($8::jsonb, destination),
              contents = COALESCE($9::jsonb, contents), handling_units = COALESCE($10::jsonb, handling_units), updated_at = NOW()
            WHERE shipment_id = $1`,
          [s.shipment_id, scac ? scac.toUpperCase() : null, trackingId || null, newPlanned, newEta, asnNumber || null,
            origin ? JSON.stringify(origin) : null, destination ? JSON.stringify(destination) : null,
            contents ? JSON.stringify(contents) : null, hus ? JSON.stringify(hus) : null]
        );
      });
      const s = await loadShipment(pool, req.params.shipmentId);
      res.json(mapShipment(s));
    })
  );

  r.delete(
    '/shipments/:shipmentId',
    asyncHandler(async (req, res) => {
      await withTransaction(pool, async (c) => {
        const s = await loadShipment(c, req.params.shipmentId, { lock: true });
        if (s.milestone !== 'PLN') {
          throw new ApiError(409, 'SHIPMENT_NOT_DRAFT', `Only planned (PLN) shipments can be deleted; this one is ${s.milestone}. Use POST /cancel instead.`);
        }
        await c.query('DELETE FROM tms.shipments WHERE shipment_id = $1', [s.shipment_id]);
      });
      res.status(204).end();
    })
  );

  return r;
};
