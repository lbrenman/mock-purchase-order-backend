'use strict';

const express = require('express');
const { ApiError, asyncHandler } = require('../../shared/errors');
const { withTransaction } = require('../../shared/db');
const { Validator, toSapDate, toSapTimestamp, fixed, csv, intParam, parseTimestampLoose } = require('../../shared/validate');

const STATUS_CODES = {
  '01': 'Open',
  '02': 'Partially confirmed',
  '03': 'Confirmed',
  '04': 'In delivery',
  '05': 'Closed',
  '09': 'Cancelled',
};
const LOCKED = ['05', '09'];
const CONF_CATEGORIES = {
  AB: 'Order acknowledgement - accepted as ordered',
  AC: 'Order acknowledgement - accepted with changes',
  RJ: 'Order rejected by vendor',
};
const PO_RE = /^[0-9]{10}$/;
const VENDOR_RE = /^[0-9]{10}$/;
const ITEM_RE = /^[0-9]{5}$/;

const etagFor = (po) => `W/"${po.po_number}-r${po.revision}"`;

// ─── Mappers (DB row -> ERP wire format: snake_case, SAP dates, string decimals) ───
function mapItem(r) {
  const open = Math.max(Number(r.quantity) - Number(r.shipped_qty), 0);
  return {
    item_no: r.item_no,
    material: r.material,
    short_text: r.short_text,
    quantity: fixed(r.quantity, 3),
    uom: r.uom,
    net_price: fixed(r.net_price, 2),
    price_unit: r.price_unit,
    confirmed_qty: fixed(r.confirmed_qty, 3),
    confirmed_date: toSapDate(r.confirmed_date),
    shipped_qty: fixed(r.shipped_qty, 3),
    open_qty: fixed(open, 3),
    reject_reason: r.reject_reason,
  };
}

function mapHeader(r) {
  const h = {
    po_number: r.po_number,
    vendor_id: r.vendor_id,
    purch_org: r.purch_org,
    doc_date: toSapDate(r.doc_date),
    currency: r.currency,
    status_code: r.status_code,
    status_text: STATUS_CODES[r.status_code] || 'Unknown',
    delivery_date: toSapDate(r.delivery_date),
    plant: r.plant,
    incoterms: r.incoterms,
    payment_terms: r.payment_terms,
    buyer_name: r.buyer_name,
    revision: r.revision,
    created_at: toSapTimestamp(r.created_at),
    changed_at: toSapTimestamp(r.changed_at),
  };
  if (r.item_count !== undefined) h.item_count = r.item_count;
  return h;
}

function mapConfirmation(r) {
  return {
    confirmation_no: r.confirmation_no,
    po_number: r.po_number,
    po_revision: r.po_revision,
    conf_category: r.conf_category,
    conf_category_text: CONF_CATEGORIES[r.conf_category],
    vendor_reference: r.vendor_reference,
    note: r.note,
    status: r.status,
    items: r.items,
    posted_at: toSapTimestamp(r.posted_at),
  };
}

function mapDelivery(r) {
  return {
    delivery_no: r.delivery_no,
    vendor_id: r.vendor_id,
    asn_reference: r.asn_reference,
    status: r.status,
    items: r.items,
    posted_at: toSapTimestamp(r.posted_at),
    reversed_at: toSapTimestamp(r.reversed_at),
  };
}

function paginationMeta(total, page, limit) {
  const totalPages = Math.max(Math.ceil(total / limit), 1);
  return { total, page, limit, totalPages, hasNext: page < totalPages, hasPrev: page > 1 };
}

function assertPoNumber(v) {
  if (!PO_RE.test(v)) {
    throw new ApiError(400, 'INVALID_PO_NUMBER', 'ERP purchase order numbers are exactly 10 digits (no prefix)', [
      { field: 'po_number', message: 'must match ^[0-9]{10}$' },
    ]);
  }
}

async function loadPo(db, poNumber, { lock = false } = {}) {
  const { rows } = await db.query(
    `SELECT * FROM erp.purchase_orders WHERE po_number = $1 ${lock ? 'FOR UPDATE' : ''}`,
    [poNumber]
  );
  if (!rows[0]) throw new ApiError(404, 'PO_NOT_FOUND', `Purchase order ${poNumber} does not exist`);
  return rows[0];
}

async function loadItems(db, poNumbers) {
  const { rows } = await db.query(
    'SELECT * FROM erp.po_items WHERE po_number = ANY($1) ORDER BY po_number, item_no',
    [poNumbers]
  );
  return rows;
}

/** Derive header status from item quantities (keeps 05/09 untouched). */
async function recomputeStatus(client, poNumber) {
  const po = await loadPo(client, poNumber, { lock: true });
  if (LOCKED.includes(po.status_code)) return po.status_code;
  const items = await loadItems(client, [poNumber]);
  let status = '01';
  if (items.some((i) => Number(i.shipped_qty) > 0)) status = '04';
  else if (items.every((i) => Number(i.confirmed_qty) >= Number(i.quantity))) status = '03';
  else if (items.some((i) => Number(i.confirmed_qty) > 0)) status = '02';
  await client.query('UPDATE erp.purchase_orders SET status_code = $2, changed_at = NOW() WHERE po_number = $1', [
    poNumber,
    status,
  ]);
  return status;
}

async function fullPo(db, poNumber) {
  const po = await loadPo(db, poNumber);
  const items = await loadItems(db, [poNumber]);
  return { po, body: { ...mapHeader(po), items: items.map(mapItem) } };
}

module.exports = function buildErpRoutes({ pool, idem }) {
  const r = express.Router();

  // ─── Reference data ──────────────────────────────────────────────────────
  r.get('/reference/status-codes', (req, res) => {
    res.json({ data: Object.entries(STATUS_CODES).map(([code, text]) => ({ status_code: code, status_text: text })) });
  });

  r.get('/reference/confirmation-categories', (req, res) => {
    res.json({ data: Object.entries(CONF_CATEGORIES).map(([code, text]) => ({ conf_category: code, text })) });
  });

  r.get(
    '/reference/purchasing-orgs',
    asyncHandler(async (req, res) => {
      const { rows } = await pool.query('SELECT code, name, company_code FROM erp.purchasing_orgs ORDER BY code');
      res.json({ data: rows });
    })
  );

  r.get(
    '/plants',
    asyncHandler(async (req, res) => {
      const params = [];
      let where = '';
      if (req.query.site_code) {
        params.push(req.query.site_code);
        where = 'WHERE site_code = $1';
      }
      const { rows } = await pool.query(
        `SELECT plant_code, site_code, name, street, city, region, postal_code, country FROM erp.plants ${where} ORDER BY plant_code`,
        params
      );
      res.json({ data: rows });
    })
  );

  r.get(
    '/plants/:plantCode',
    asyncHandler(async (req, res) => {
      const { rows } = await pool.query(
        'SELECT plant_code, site_code, name, street, city, region, postal_code, country FROM erp.plants WHERE plant_code = $1',
        [req.params.plantCode]
      );
      if (!rows[0]) throw new ApiError(404, 'PLANT_NOT_FOUND', `Plant ${req.params.plantCode} does not exist`);
      res.json({ data: rows[0] });
    })
  );

  // ─── Purchase orders ─────────────────────────────────────────────────────
  r.get(
    '/purchase-orders',
    asyncHandler(async (req, res) => {
      const page = intParam(req.query.page, { def: 1, min: 1, max: 100000, name: 'page' });
      const limit = intParam(req.query.limit, { def: 25, min: 1, max: 200, name: 'limit' });
      const conds = [];
      const params = [];
      const add = (sql, val) => {
        params.push(val);
        conds.push(sql.replace('?', `$${params.length}`));
      };

      const vendors = csv(req.query.vendor_id);
      if (vendors.length) add('po.vendor_id = ANY(?)', vendors);

      const statuses = csv(req.query.status);
      const badStatus = statuses.filter((s) => !STATUS_CODES[s]);
      if (badStatus.length) {
        throw new ApiError(400, 'INVALID_QUERY_PARAMETER', `Unknown status code(s): ${badStatus.join(', ')}`, [
          { field: 'status', message: `allowed: ${Object.keys(STATUS_CODES).join(', ')}` },
        ]);
      }
      if (statuses.length) add('po.status_code = ANY(?)', statuses);

      if (req.query.changed_since) {
        const ts = parseTimestampLoose(String(req.query.changed_since));
        if (!ts) {
          throw new ApiError(400, 'INVALID_QUERY_PARAMETER', 'changed_since must be YYYYMMDDhhmmss or ISO-8601', [
            { field: 'changed_since', message: 'invalid timestamp' },
          ]);
        }
        add('po.changed_at >= ?', ts);
      }
      const plants = csv(req.query.plant);
      if (plants.length) add('po.plant = ANY(?)', plants);
      const orgs = csv(req.query.purch_org);
      if (orgs.length) add('po.purch_org = ANY(?)', orgs);
      const poNumbers = csv(req.query.po_number);
      if (poNumbers.length) add('po.po_number = ANY(?)', poNumbers);

      const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
      const total = (await pool.query(`SELECT COUNT(*)::int AS n FROM erp.purchase_orders po ${where}`, params)).rows[0].n;
      const { rows } = await pool.query(
        `SELECT po.*, (SELECT COUNT(*)::int FROM erp.po_items i WHERE i.po_number = po.po_number) AS item_count
           FROM erp.purchase_orders po ${where}
          ORDER BY po.po_number
          LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
        params
      );

      const data = rows.map(mapHeader);
      if (csv(req.query.include).includes('items') && rows.length) {
        const items = await loadItems(pool, rows.map((x) => x.po_number));
        data.forEach((h) => {
          h.items = items.filter((i) => i.po_number === h.po_number).map(mapItem);
        });
      }
      res.json({ data, pagination: paginationMeta(total, page, limit) });
    })
  );

  r.post(
    '/purchase-orders',
    idem,
    asyncHandler(async (req, res) => {
      const b = req.body || {};
      const v = new Validator();
      const poNumber = v.string(b, 'po_number', { pattern: PO_RE });
      const vendorId = v.string(b, 'vendor_id', { required: true, pattern: VENDOR_RE });
      const purchOrg = v.string(b, 'purch_org', { required: true, max: 10 });
      const currency = v.string(b, 'currency', { required: true, pattern: /^[A-Z]{3}$/ });
      const docDate = v.date(b, 'doc_date') || new Date().toISOString().slice(0, 10);
      const deliveryDate = v.date(b, 'delivery_date', { required: true });
      const plant = v.string(b, 'plant', { required: true, max: 10 });
      const incoterms = v.string(b, 'incoterms', { max: 10 });
      const paymentTerms = v.string(b, 'payment_terms', { max: 10 });
      const buyer = v.string(b, 'buyer_name', { max: 80 });
      const items = v.array(b, 'items', { required: true, minItems: 1 }) || [];
      items.forEach((it, i) => {
        const p = `items[${i}]`;
        v.string(it, 'item_no', { pattern: ITEM_RE, path: `${p}.item_no` });
        v.string(it, 'material', { required: true, max: 60, path: `${p}.material` });
        v.string(it, 'short_text', { required: true, max: 240, path: `${p}.short_text` });
        v.number(it, 'quantity', { required: true, exclusiveMin: 0, path: `${p}.quantity` });
        v.string(it, 'uom', { required: true, max: 12, path: `${p}.uom` });
        v.number(it, 'net_price', { min: 0, path: `${p}.net_price` });
      });
      v.throwIfErrors();

      const created = await withTransaction(pool, async (c) => {
        let number = poNumber;
        if (!number) {
          const { rows } = await c.query(
            "SELECT LPAD((COALESCE(MAX(po_number::bigint), 4500123455) + 1)::text, 10, '0') AS next FROM erp.purchase_orders"
          );
          number = rows[0].next;
        }
        await c.query(
          `INSERT INTO erp.purchase_orders (po_number, vendor_id, purch_org, doc_date, currency, status_code, delivery_date,
              plant, incoterms, payment_terms, buyer_name)
           VALUES ($1,$2,$3,$4,$5,'01',$6,$7,$8,$9,$10)`,
          [number, vendorId, purchOrg, docDate, currency, deliveryDate, plant, incoterms || null, paymentTerms || null, buyer || null]
        );
        for (let i = 0; i < items.length; i += 1) {
          const it = items[i];
          const itemNo = it.item_no || String((i + 1) * 10).padStart(5, '0');
          await c.query(
            `INSERT INTO erp.po_items (po_number, item_no, material, short_text, quantity, uom, net_price)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [number, itemNo, it.material, it.short_text, it.quantity, it.uom, it.net_price || 0]
          );
        }
        return number;
      });

      const { po, body } = await fullPo(pool, created);
      res.status(201).set('Location', `/erp/v1/purchase-orders/${created}`).set('ETag', etagFor(po)).json({ data: body });
    })
  );

  r.get(
    '/purchase-orders/:poNumber',
    asyncHandler(async (req, res) => {
      assertPoNumber(req.params.poNumber);
      const { po, body } = await fullPo(pool, req.params.poNumber);
      const etag = etagFor(po);
      if (req.get('if-none-match') === etag) return res.status(304).set('ETag', etag).end();
      return res.set('ETag', etag).json({ data: body });
    })
  );

  /** Buyer-side change (simulates a PO revision; allows the supplier to re-confirm). */
  r.patch(
    '/purchase-orders/:poNumber',
    asyncHandler(async (req, res) => {
      assertPoNumber(req.params.poNumber);
      const b = req.body || {};
      const v = new Validator();
      const deliveryDate = v.date(b, 'delivery_date');
      const statusCode = v.string(b, 'status_code', { oneOf: ['05', '09'] });
      const buyer = v.string(b, 'buyer_name', { max: 80 });
      const incoterms = v.string(b, 'incoterms', { max: 10 });
      const paymentTerms = v.string(b, 'payment_terms', { max: 10 });
      const items = v.array(b, 'items') || [];
      items.forEach((it, i) => {
        v.string(it, 'item_no', { required: true, pattern: ITEM_RE, path: `items[${i}].item_no` });
        v.number(it, 'quantity', { exclusiveMin: 0, path: `items[${i}].quantity` });
        v.number(it, 'net_price', { min: 0, path: `items[${i}].net_price` });
      });
      if (!deliveryDate && !statusCode && !buyer && !incoterms && !paymentTerms && !items.length) {
        v.add('body', 'provide at least one of delivery_date, status_code, buyer_name, incoterms, payment_terms, items');
      }
      v.throwIfErrors();

      await withTransaction(pool, async (c) => {
        const po = await loadPo(c, req.params.poNumber, { lock: true });
        if (LOCKED.includes(po.status_code)) {
          throw new ApiError(409, 'PO_LOCKED', `Purchase order is ${STATUS_CODES[po.status_code].toLowerCase()} and cannot be changed`);
        }
        const existing = await loadItems(c, [po.po_number]);
        for (const it of items) {
          const cur = existing.find((e) => e.item_no === it.item_no);
          if (!cur) throw new ApiError(422, 'ITEM_NOT_FOUND', `Item ${it.item_no} does not exist on PO ${po.po_number}`);
          if (it.quantity !== undefined && Number(it.quantity) < Number(cur.shipped_qty)) {
            throw new ApiError(422, 'QUANTITY_BELOW_SHIPPED', `Item ${it.item_no} quantity cannot be below shipped quantity ${cur.shipped_qty}`);
          }
          await c.query(
            `UPDATE erp.po_items SET quantity = COALESCE($3, quantity), net_price = COALESCE($4, net_price)
              WHERE po_number = $1 AND item_no = $2`,
            [po.po_number, it.item_no, it.quantity ?? null, it.net_price ?? null]
          );
        }
        await c.query(
          `UPDATE erp.purchase_orders
              SET delivery_date = COALESCE($2, delivery_date), buyer_name = COALESCE($3, buyer_name),
                  status_code = COALESCE($4, status_code), incoterms = COALESCE($5, incoterms),
                  payment_terms = COALESCE($6, payment_terms), revision = revision + 1, changed_at = NOW()
            WHERE po_number = $1`,
          [po.po_number, deliveryDate || null, buyer || null, statusCode || null, incoterms || null, paymentTerms || null]
        );
        if (!statusCode) await recomputeStatus(c, po.po_number);
      });

      const { po, body } = await fullPo(pool, req.params.poNumber);
      res.set('ETag', etagFor(po)).json({ data: body });
    })
  );

  r.get(
    '/purchase-orders/:poNumber/items',
    asyncHandler(async (req, res) => {
      assertPoNumber(req.params.poNumber);
      await loadPo(pool, req.params.poNumber);
      const items = await loadItems(pool, [req.params.poNumber]);
      res.json({ data: items.map(mapItem) });
    })
  );

  // ─── Confirmations (supplier acknowledgements) ───────────────────────────
  r.get(
    '/purchase-orders/:poNumber/confirmations',
    asyncHandler(async (req, res) => {
      assertPoNumber(req.params.poNumber);
      await loadPo(pool, req.params.poNumber);
      const { rows } = await pool.query(
        'SELECT * FROM erp.confirmations WHERE po_number = $1 ORDER BY posted_at DESC',
        [req.params.poNumber]
      );
      res.json({ data: rows.map(mapConfirmation) });
    })
  );

  r.post(
    '/purchase-orders/:poNumber/confirmations',
    idem,
    asyncHandler(async (req, res) => {
      assertPoNumber(req.params.poNumber);
      const b = req.body || {};
      const v = new Validator();
      const category = v.string(b, 'conf_category', { required: true, oneOf: Object.keys(CONF_CATEGORIES) });
      const vendorRef = v.string(b, 'vendor_reference', { max: 80 });
      const note = v.string(b, 'note', { max: 1000 });
      const items = v.array(b, 'items', { required: true, minItems: 1 }) || [];
      const parsed = items.map((it, i) => {
        const p = `items[${i}]`;
        return {
          item_no: v.string(it, 'item_no', { required: true, pattern: ITEM_RE, path: `${p}.item_no` }),
          confirmed_qty: v.number(it, 'confirmed_qty', { required: true, min: 0, path: `${p}.confirmed_qty` }),
          confirmed_date: v.date(it, 'confirmed_date', { path: `${p}.confirmed_date` }),
          reject_reason: v.string(it, 'reject_reason', { max: 60, path: `${p}.reject_reason` }),
        };
      });
      const dupes = parsed.map((p) => p.item_no).filter((x, i, a) => x && a.indexOf(x) !== i);
      if (dupes.length) v.add('items', `duplicate item_no: ${[...new Set(dupes)].join(', ')}`);
      v.throwIfErrors();

      const conf = await withTransaction(pool, async (c) => {
        const po = await loadPo(c, req.params.poNumber, { lock: true });
        const ifMatch = req.get('if-match');
        if (ifMatch && ifMatch !== etagFor(po) && ifMatch !== '*') {
          throw new ApiError(412, 'REVISION_MISMATCH', `PO is at revision ${po.revision}; If-Match ${ifMatch} is stale`);
        }
        if (LOCKED.includes(po.status_code)) {
          throw new ApiError(422, 'PO_NOT_CONFIRMABLE', `Purchase order is ${STATUS_CODES[po.status_code].toLowerCase()} and cannot be confirmed`);
        }
        const existing = await c.query('SELECT confirmation_no FROM erp.confirmations WHERE po_number = $1 AND po_revision = $2', [
          po.po_number,
          po.revision,
        ]);
        if (existing.rows[0]) {
          throw new ApiError(
            409,
            'CONFIRMATION_EXISTS',
            `Confirmation ${existing.rows[0].confirmation_no} already exists for revision ${po.revision} of PO ${po.po_number}`
          );
        }

        const poItems = await loadItems(c, [po.po_number]);
        const violations = [];
        let needsReview = false;
        parsed.forEach((p, i) => {
          const cur = poItems.find((x) => x.item_no === p.item_no);
          if (!cur) return void violations.push({ field: `items[${i}].item_no`, message: `item ${p.item_no} does not exist on this PO` });
          const qty = Number(cur.quantity);
          if (p.confirmed_qty > qty) {
            violations.push({ field: `items[${i}].confirmed_qty`, message: `over-confirmation: ordered ${fixed(qty, 3)}` });
          }
          if (category === 'RJ' && p.confirmed_qty !== 0) {
            violations.push({ field: `items[${i}].confirmed_qty`, message: 'must be 0 for a rejection (RJ)' });
          }
          if (category === 'AB') {
            if (p.confirmed_qty !== qty) violations.push({ field: `items[${i}].confirmed_qty`, message: 'AB requires the full ordered quantity; use AC for changes' });
            if (p.confirmed_date && p.confirmed_date !== po.delivery_date) {
              violations.push({ field: `items[${i}].confirmed_date`, message: 'AB requires the requested delivery date; use AC for changes' });
            }
          }
          if (category === 'AC' && (p.confirmed_qty < qty || (p.confirmed_date && p.confirmed_date > po.delivery_date))) {
            needsReview = true;
          }
        });
        if (violations.length) {
          throw new ApiError(422, 'CONFIRMATION_RULE_VIOLATION', 'The confirmation violates purchasing business rules', violations);
        }

        const storedItems = parsed.map((p) => {
          const date = category === 'RJ' ? null : p.confirmed_date || po.delivery_date;
          return {
            item_no: p.item_no,
            confirmed_qty: fixed(p.confirmed_qty, 3),
            confirmed_date: toSapDate(date),
            reject_reason: p.reject_reason || (category === 'RJ' ? 'VENDOR_REJECTED' : null),
          };
        });
        for (const s of storedItems) {
          await c.query(
            `UPDATE erp.po_items SET confirmed_qty = $3, confirmed_date = $4, reject_reason = $5
              WHERE po_number = $1 AND item_no = $2`,
            [po.po_number, s.item_no, s.confirmed_qty, s.confirmed_date, s.reject_reason]
          );
        }
        const seq = await c.query("SELECT nextval('erp.confirmation_seq')::text AS n");
        const { rows } = await c.query(
          `INSERT INTO erp.confirmations (confirmation_no, po_number, po_revision, conf_category, vendor_reference, note, status, items)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
          [seq.rows[0].n, po.po_number, po.revision, category, vendorRef || null, note || null,
            needsReview ? 'IN_REVIEW' : 'POSTED', JSON.stringify(storedItems)]
        );
        await recomputeStatus(c, po.po_number);
        return rows[0];
      });

      res.status(201).set('Location', `/erp/v1/confirmations/${conf.confirmation_no}`).json({ data: mapConfirmation(conf) });
    })
  );

  r.get(
    '/confirmations/:confirmationNo',
    asyncHandler(async (req, res) => {
      const { rows } = await pool.query('SELECT * FROM erp.confirmations WHERE confirmation_no = $1', [req.params.confirmationNo]);
      if (!rows[0]) throw new ApiError(404, 'CONFIRMATION_NOT_FOUND', `Confirmation ${req.params.confirmationNo} does not exist`);
      res.json({ data: mapConfirmation(rows[0]) });
    })
  );

  // ─── Inbound deliveries (ERP side of an ASN: reserves open quantity) ─────
  r.get(
    '/inbound-deliveries',
    asyncHandler(async (req, res) => {
      const page = intParam(req.query.page, { def: 1, min: 1, max: 100000, name: 'page' });
      const limit = intParam(req.query.limit, { def: 25, min: 1, max: 200, name: 'limit' });
      const conds = [];
      const params = [];
      if (req.query.asn_reference) {
        params.push(req.query.asn_reference);
        conds.push(`asn_reference = $${params.length}`);
      }
      if (req.query.vendor_id) {
        params.push(req.query.vendor_id);
        conds.push(`vendor_id = $${params.length}`);
      }
      if (req.query.po_number) {
        params.push(JSON.stringify([{ po_number: req.query.po_number }]));
        conds.push(`items @> $${params.length}::jsonb`);
      }
      if (req.query.status) {
        params.push(req.query.status);
        conds.push(`status = $${params.length}`);
      }
      const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
      const total = (await pool.query(`SELECT COUNT(*)::int AS n FROM erp.inbound_deliveries ${where}`, params)).rows[0].n;
      const { rows } = await pool.query(
        `SELECT * FROM erp.inbound_deliveries ${where} ORDER BY posted_at DESC LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
        params
      );
      res.json({ data: rows.map(mapDelivery), pagination: paginationMeta(total, page, limit) });
    })
  );

  r.get(
    '/inbound-deliveries/:deliveryNo',
    asyncHandler(async (req, res) => {
      const { rows } = await pool.query('SELECT * FROM erp.inbound_deliveries WHERE delivery_no = $1', [req.params.deliveryNo]);
      if (!rows[0]) throw new ApiError(404, 'DELIVERY_NOT_FOUND', `Inbound delivery ${req.params.deliveryNo} does not exist`);
      res.json({ data: mapDelivery(rows[0]) });
    })
  );

  r.post(
    '/inbound-deliveries',
    idem,
    asyncHandler(async (req, res) => {
      const b = req.body || {};
      const v = new Validator();
      const asnRef = v.string(b, 'asn_reference', { required: true, max: 80 });
      const vendorId = v.string(b, 'vendor_id', { required: true, pattern: VENDOR_RE });
      const items = v.array(b, 'items', { required: true, minItems: 1 }) || [];
      const parsed = items.map((it, i) => ({
        po_number: v.string(it, 'po_number', { required: true, pattern: PO_RE, path: `items[${i}].po_number` }),
        item_no: v.string(it, 'item_no', { required: true, pattern: ITEM_RE, path: `items[${i}].item_no` }),
        quantity: v.number(it, 'quantity', { required: true, exclusiveMin: 0, path: `items[${i}].quantity` }),
      }));
      v.throwIfErrors();

      const delivery = await withTransaction(pool, async (c) => {
        const dup = await c.query(
          "SELECT delivery_no FROM erp.inbound_deliveries WHERE vendor_id = $1 AND asn_reference = $2 AND status = 'POSTED'",
          [vendorId, asnRef]
        );
        if (dup.rows[0]) {
          throw new ApiError(409, 'DELIVERY_EXISTS', `ASN ${asnRef} is already posted as inbound delivery ${dup.rows[0].delivery_no}`);
        }

        const poNumbers = [...new Set(parsed.map((p) => p.po_number))].sort();
        const pos = {};
        for (const n of poNumbers) {
          const { rows } = await c.query('SELECT * FROM erp.purchase_orders WHERE po_number = $1 FOR UPDATE', [n]);
          pos[n] = rows[0];
        }
        const poItems = poNumbers.length ? await loadItems(c, poNumbers) : [];
        const requested = {};
        parsed.forEach((p) => {
          const k = `${p.po_number}/${p.item_no}`;
          requested[k] = (requested[k] || 0) + p.quantity;
        });

        const violations = [];
        let code = 'DELIVERY_RULE_VIOLATION';
        parsed.forEach((p, i) => {
          const po = pos[p.po_number];
          if (!po) return void violations.push({ field: `items[${i}].po_number`, message: `PO ${p.po_number} does not exist` });
          if (po.vendor_id !== vendorId) {
            return void violations.push({ field: `items[${i}].po_number`, message: `PO ${p.po_number} belongs to a different vendor` });
          }
          if (LOCKED.includes(po.status_code)) {
            return void violations.push({ field: `items[${i}].po_number`, message: `PO ${p.po_number} is ${STATUS_CODES[po.status_code].toLowerCase()}` });
          }
          const cur = poItems.find((x) => x.po_number === p.po_number && x.item_no === p.item_no);
          if (!cur) return void violations.push({ field: `items[${i}].item_no`, message: `item ${p.item_no} does not exist on PO ${p.po_number}` });
          const open = Number(cur.quantity) - Number(cur.shipped_qty);
          if (requested[`${p.po_number}/${p.item_no}`] > open + 1e-9) {
            code = 'SHIPPED_QUANTITY_EXCEEDS_OPEN_QUANTITY';
            violations.push({ field: `items[${i}].quantity`, message: `exceeds open quantity ${fixed(open, 3)} for ${p.po_number}/${p.item_no}` });
          }
        });
        if (violations.length) {
          const msg = code === 'SHIPPED_QUANTITY_EXCEEDS_OPEN_QUANTITY'
            ? 'Shipped quantity exceeds the remaining open quantity'
            : 'The inbound delivery violates purchasing business rules';
          throw new ApiError(422, code, msg, violations);
        }

        for (const p of parsed) {
          await c.query('UPDATE erp.po_items SET shipped_qty = shipped_qty + $3 WHERE po_number = $1 AND item_no = $2', [
            p.po_number,
            p.item_no,
            p.quantity,
          ]);
        }
        for (const n of poNumbers) await recomputeStatus(c, n);

        const seq = await c.query("SELECT nextval('erp.delivery_seq')::text AS n");
        const stored = parsed.map((p) => ({ po_number: p.po_number, item_no: p.item_no, quantity: fixed(p.quantity, 3) }));
        const { rows } = await c.query(
          `INSERT INTO erp.inbound_deliveries (delivery_no, vendor_id, asn_reference, items, status)
           VALUES ($1,$2,$3,$4,'POSTED') RETURNING *`,
          [seq.rows[0].n, vendorId, asnRef, JSON.stringify(stored)]
        );
        return rows[0];
      });

      res.status(201).set('Location', `/erp/v1/inbound-deliveries/${delivery.delivery_no}`).json({ data: mapDelivery(delivery) });
    })
  );

  /** Compensation: releases the reserved quantity (e.g. when the TMS step of an orchestration fails). */
  r.post(
    '/inbound-deliveries/:deliveryNo/reverse',
    idem,
    asyncHandler(async (req, res) => {
      const delivery = await withTransaction(pool, async (c) => {
        const { rows } = await c.query('SELECT * FROM erp.inbound_deliveries WHERE delivery_no = $1 FOR UPDATE', [req.params.deliveryNo]);
        const d = rows[0];
        if (!d) throw new ApiError(404, 'DELIVERY_NOT_FOUND', `Inbound delivery ${req.params.deliveryNo} does not exist`);
        if (d.status === 'REVERSED') throw new ApiError(409, 'DELIVERY_ALREADY_REVERSED', `Inbound delivery ${d.delivery_no} was already reversed`);
        const poNumbers = [...new Set(d.items.map((i) => i.po_number))].sort();
        for (const n of poNumbers) await loadPo(c, n, { lock: true });
        for (const it of d.items) {
          await c.query(
            'UPDATE erp.po_items SET shipped_qty = GREATEST(shipped_qty - $3, 0) WHERE po_number = $1 AND item_no = $2',
            [it.po_number, it.item_no, it.quantity]
          );
        }
        for (const n of poNumbers) await recomputeStatus(c, n);
        const upd = await c.query(
          "UPDATE erp.inbound_deliveries SET status = 'REVERSED', reversed_at = NOW() WHERE delivery_no = $1 RETURNING *",
          [d.delivery_no]
        );
        return upd.rows[0];
      });
      res.json({ data: mapDelivery(delivery) });
    })
  );


  // ═══ Maintenance (CRUD) endpoints used by the dashboard and Postman ═══════

  // ─── Purchasing organisations ────────────────────────────────────────────
  const ORG_RE = /^[A-Z0-9]{2,10}$/;
  async function loadOrg(code) {
    const { rows } = await pool.query('SELECT code, name, company_code FROM erp.purchasing_orgs WHERE code = $1', [code]);
    if (!rows[0]) throw new ApiError(404, 'PURCH_ORG_NOT_FOUND', `Purchasing organisation ${code} does not exist`);
    return rows[0];
  }

  r.get(
    '/reference/purchasing-orgs/:code',
    asyncHandler(async (req, res) => {
      res.json({ data: await loadOrg(req.params.code) });
    })
  );

  r.post(
    '/reference/purchasing-orgs',
    idem,
    asyncHandler(async (req, res) => {
      const v = new Validator();
      const b = req.body || {};
      const code = v.string(b, 'code', { required: true, pattern: ORG_RE });
      const name = v.string(b, 'name', { required: true, max: 80 });
      const companyCode = v.string(b, 'company_code', { required: true, max: 10 });
      v.throwIfErrors();
      await pool.query('INSERT INTO erp.purchasing_orgs (code, name, company_code) VALUES ($1,$2,$3)', [code, name, companyCode]);
      res.status(201).set('Location', `/erp/v1/reference/purchasing-orgs/${code}`).json({ data: await loadOrg(code) });
    })
  );

  r.patch(
    '/reference/purchasing-orgs/:code',
    asyncHandler(async (req, res) => {
      const v = new Validator();
      const b = req.body || {};
      const name = v.string(b, 'name', { max: 80 });
      const companyCode = v.string(b, 'company_code', { max: 10 });
      if (!name && !companyCode) v.add('body', 'provide name and/or company_code');
      v.throwIfErrors();
      await loadOrg(req.params.code);
      await pool.query(
        'UPDATE erp.purchasing_orgs SET name = COALESCE($2, name), company_code = COALESCE($3, company_code), updated_at = NOW() WHERE code = $1',
        [req.params.code, name || null, companyCode || null]
      );
      res.json({ data: await loadOrg(req.params.code) });
    })
  );

  r.delete(
    '/reference/purchasing-orgs/:code',
    asyncHandler(async (req, res) => {
      await loadOrg(req.params.code);
      const used = await pool.query('SELECT COUNT(*)::int AS n FROM erp.purchase_orders WHERE purch_org = $1', [req.params.code]);
      if (used.rows[0].n) {
        throw new ApiError(409, 'PURCH_ORG_IN_USE', `Purchasing organisation ${req.params.code} is used by ${used.rows[0].n} purchase order(s)`);
      }
      await pool.query('DELETE FROM erp.purchasing_orgs WHERE code = $1', [req.params.code]);
      res.status(204).end();
    })
  );

  // ─── Plants ──────────────────────────────────────────────────────────────
  const PLANT_COLS = 'plant_code, site_code, name, street, city, region, postal_code, country';
  async function loadPlant(code) {
    const { rows } = await pool.query(`SELECT ${PLANT_COLS} FROM erp.plants WHERE plant_code = $1`, [code]);
    if (!rows[0]) throw new ApiError(404, 'PLANT_NOT_FOUND', `Plant ${code} does not exist`);
    return rows[0];
  }
  function plantFields(v, b, required) {
    return {
      site_code: v.string(b, 'site_code', { required, max: 40, pattern: /^[A-Z0-9-]+$/ }),
      name: v.string(b, 'name', { required, max: 120 }),
      street: v.string(b, 'street', { max: 120 }),
      city: v.string(b, 'city', { max: 80 }),
      region: v.string(b, 'region', { max: 80 }),
      postal_code: v.string(b, 'postal_code', { max: 20 }),
      country: v.string(b, 'country', { required, pattern: /^[A-Z]{2}$/ }),
    };
  }

  r.post(
    '/plants',
    idem,
    asyncHandler(async (req, res) => {
      const v = new Validator();
      const b = req.body || {};
      const code = v.string(b, 'plant_code', { required: true, pattern: /^[0-9]{4}$/ });
      const f = plantFields(v, b, true);
      v.throwIfErrors();
      await pool.query(
        `INSERT INTO erp.plants (${PLANT_COLS}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [code, f.site_code, f.name, f.street || null, f.city || null, f.region || null, f.postal_code || null, f.country]
      );
      res.status(201).set('Location', `/erp/v1/plants/${code}`).json({ data: await loadPlant(code) });
    })
  );

  r.patch(
    '/plants/:plantCode',
    asyncHandler(async (req, res) => {
      const v = new Validator();
      const f = plantFields(v, req.body || {}, false);
      if (Object.values(f).every((x) => x === undefined)) v.add('body', 'provide at least one plant field');
      v.throwIfErrors();
      await loadPlant(req.params.plantCode);
      await pool.query(
        `UPDATE erp.plants SET site_code = COALESCE($2, site_code), name = COALESCE($3, name), street = COALESCE($4, street),
            city = COALESCE($5, city), region = COALESCE($6, region), postal_code = COALESCE($7, postal_code),
            country = COALESCE($8, country), updated_at = NOW()
          WHERE plant_code = $1`,
        [req.params.plantCode, f.site_code || null, f.name || null, f.street || null, f.city || null, f.region || null,
          f.postal_code || null, f.country || null]
      );
      res.json({ data: await loadPlant(req.params.plantCode) });
    })
  );

  r.delete(
    '/plants/:plantCode',
    asyncHandler(async (req, res) => {
      await loadPlant(req.params.plantCode);
      const used = await pool.query('SELECT COUNT(*)::int AS n FROM erp.purchase_orders WHERE plant = $1', [req.params.plantCode]);
      if (used.rows[0].n) {
        throw new ApiError(409, 'PLANT_IN_USE', `Plant ${req.params.plantCode} is used by ${used.rows[0].n} purchase order(s)`);
      }
      await pool.query('DELETE FROM erp.plants WHERE plant_code = $1', [req.params.plantCode]);
      res.status(204).end();
    })
  );

  // ─── Purchase order delete & item maintenance ───────────────────────────
  r.delete(
    '/purchase-orders/:poNumber',
    asyncHandler(async (req, res) => {
      assertPoNumber(req.params.poNumber);
      await withTransaction(pool, async (c) => {
        const po = await loadPo(c, req.params.poNumber, { lock: true });
        const conf = await c.query('SELECT COUNT(*)::int AS n FROM erp.confirmations WHERE po_number = $1', [po.po_number]);
        const dels = await c.query('SELECT COUNT(*)::int AS n FROM erp.inbound_deliveries WHERE items @> $1::jsonb', [
          JSON.stringify([{ po_number: po.po_number }]),
        ]);
        if (conf.rows[0].n || dels.rows[0].n) {
          throw new ApiError(
            409,
            'PO_HAS_FOLLOW_ON_DOCUMENTS',
            `PO ${po.po_number} has ${conf.rows[0].n} confirmation(s) and ${dels.rows[0].n} inbound deliverie(s); cancel it instead (PATCH status_code 09)`
          );
        }
        await c.query('DELETE FROM erp.purchase_orders WHERE po_number = $1', [po.po_number]);
      });
      res.status(204).end();
    })
  );

  async function assertChangeable(c, poNumber) {
    const po = await loadPo(c, poNumber, { lock: true });
    if (LOCKED.includes(po.status_code)) {
      throw new ApiError(409, 'PO_LOCKED', `Purchase order is ${STATUS_CODES[po.status_code].toLowerCase()} and cannot be changed`);
    }
    return po;
  }
  const bumpRevision = (c, poNumber) =>
    c.query('UPDATE erp.purchase_orders SET revision = revision + 1, changed_at = NOW() WHERE po_number = $1', [poNumber]);

  r.post(
    '/purchase-orders/:poNumber/items',
    idem,
    asyncHandler(async (req, res) => {
      assertPoNumber(req.params.poNumber);
      const b = req.body || {};
      const v = new Validator();
      const itemNo = v.string(b, 'item_no', { pattern: ITEM_RE });
      const material = v.string(b, 'material', { required: true, max: 60 });
      const text = v.string(b, 'short_text', { required: true, max: 240 });
      const qty = v.number(b, 'quantity', { required: true, exclusiveMin: 0 });
      const uom = v.string(b, 'uom', { required: true, max: 12 });
      const price = v.number(b, 'net_price', { min: 0 });
      v.throwIfErrors();
      await withTransaction(pool, async (c) => {
        const po = await assertChangeable(c, req.params.poNumber);
        let no = itemNo;
        if (!no) {
          const { rows } = await c.query(
            "SELECT LPAD((COALESCE(MAX(item_no::int), 0) + 10)::text, 5, '0') AS next FROM erp.po_items WHERE po_number = $1",
            [po.po_number]
          );
          no = rows[0].next;
        }
        await c.query(
          'INSERT INTO erp.po_items (po_number, item_no, material, short_text, quantity, uom, net_price) VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [po.po_number, no, material, text, qty, uom, price || 0]
        );
        await bumpRevision(c, po.po_number);
        await recomputeStatus(c, po.po_number);
      });
      const { po, body } = await fullPo(pool, req.params.poNumber);
      res.status(201).set('ETag', etagFor(po)).json({ data: body });
    })
  );

  r.patch(
    '/purchase-orders/:poNumber/items/:itemNo',
    asyncHandler(async (req, res) => {
      assertPoNumber(req.params.poNumber);
      const b = req.body || {};
      const v = new Validator();
      const text = v.string(b, 'short_text', { max: 240 });
      const qty = v.number(b, 'quantity', { exclusiveMin: 0 });
      const price = v.number(b, 'net_price', { min: 0 });
      if (text === undefined && qty === undefined && price === undefined) v.add('body', 'provide short_text, quantity and/or net_price');
      v.throwIfErrors();
      await withTransaction(pool, async (c) => {
        const po = await assertChangeable(c, req.params.poNumber);
        const { rows } = await c.query('SELECT * FROM erp.po_items WHERE po_number = $1 AND item_no = $2', [po.po_number, req.params.itemNo]);
        const cur = rows[0];
        if (!cur) throw new ApiError(404, 'ITEM_NOT_FOUND', `Item ${req.params.itemNo} does not exist on PO ${po.po_number}`);
        if (qty !== undefined && qty < Number(cur.shipped_qty)) {
          throw new ApiError(422, 'QUANTITY_BELOW_SHIPPED', `Quantity cannot be below shipped quantity ${fixed(cur.shipped_qty, 3)}`, [
            { field: 'quantity', message: `must be >= ${fixed(cur.shipped_qty, 3)}` },
          ]);
        }
        await c.query(
          `UPDATE erp.po_items SET short_text = COALESCE($3, short_text), quantity = COALESCE($4, quantity),
              net_price = COALESCE($5, net_price) WHERE po_number = $1 AND item_no = $2`,
          [po.po_number, cur.item_no, text ?? null, qty ?? null, price ?? null]
        );
        await bumpRevision(c, po.po_number);
        await recomputeStatus(c, po.po_number);
      });
      const { po, body } = await fullPo(pool, req.params.poNumber);
      res.set('ETag', etagFor(po)).json({ data: body });
    })
  );

  r.delete(
    '/purchase-orders/:poNumber/items/:itemNo',
    asyncHandler(async (req, res) => {
      assertPoNumber(req.params.poNumber);
      await withTransaction(pool, async (c) => {
        const po = await assertChangeable(c, req.params.poNumber);
        const items = await loadItems(c, [po.po_number]);
        const cur = items.find((i) => i.item_no === req.params.itemNo);
        if (!cur) throw new ApiError(404, 'ITEM_NOT_FOUND', `Item ${req.params.itemNo} does not exist on PO ${po.po_number}`);
        if (Number(cur.confirmed_qty) > 0 || Number(cur.shipped_qty) > 0) {
          throw new ApiError(409, 'ITEM_HAS_FOLLOW_ON_DOCUMENTS', `Item ${cur.item_no} is already confirmed or shipped and cannot be deleted`);
        }
        if (items.length === 1) {
          throw new ApiError(422, 'LAST_ITEM', 'A purchase order needs at least one item; delete or cancel the PO instead');
        }
        await c.query('DELETE FROM erp.po_items WHERE po_number = $1 AND item_no = $2', [po.po_number, cur.item_no]);
        await bumpRevision(c, po.po_number);
        await recomputeStatus(c, po.po_number);
      });
      const { po, body } = await fullPo(pool, req.params.poNumber);
      res.set('ETag', etagFor(po)).json({ data: body });
    })
  );

  // ─── Confirmation list (all POs) ─────────────────────────────────────────
  r.get(
    '/confirmations',
    asyncHandler(async (req, res) => {
      const page = intParam(req.query.page, { def: 1, min: 1, max: 100000, name: 'page' });
      const limit = intParam(req.query.limit, { def: 25, min: 1, max: 200, name: 'limit' });
      const conds = [];
      const params = [];
      const add = (sql, val) => {
        params.push(val);
        conds.push(sql.replace('?', `$${params.length}`));
      };
      const pos = csv(req.query.po_number);
      if (pos.length) add('c.po_number = ANY(?)', pos);
      const statuses = csv(req.query.status);
      if (statuses.length) add('c.status = ANY(?)', statuses);
      const cats = csv(req.query.conf_category);
      if (cats.length) add('c.conf_category = ANY(?)', cats);
      const vendors = csv(req.query.vendor_id);
      if (vendors.length) add('po.vendor_id = ANY(?)', vendors);
      const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
      const from = 'FROM erp.confirmations c JOIN erp.purchase_orders po ON po.po_number = c.po_number';
      const total = (await pool.query(`SELECT COUNT(*)::int AS n ${from} ${where}`, params)).rows[0].n;
      const { rows } = await pool.query(
        `SELECT c.*, po.vendor_id ${from} ${where} ORDER BY c.posted_at DESC LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
        params
      );
      res.json({ data: rows.map((x) => ({ ...mapConfirmation(x), vendor_id: x.vendor_id })), pagination: paginationMeta(total, page, limit) });
    })
  );

  return r;
};
