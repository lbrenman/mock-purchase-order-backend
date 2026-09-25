'use strict';

const express = require('express');
const { ApiError, asyncHandler } = require('../../shared/errors');
const { Validator, csv, intParam, toIso } = require('../../shared/validate');

const STATUSES = ['ACTIVE', 'ON_HOLD', 'BLOCKED'];
const TIERS = ['STRATEGIC', 'PREFERRED', 'APPROVED', 'CONDITIONAL'];
const RISK = ['LOW', 'MEDIUM', 'HIGH'];
const SITE_TYPES = ['SHIP_FROM', 'REMIT_TO', 'MANUFACTURING'];
const ROLES = ['PRIMARY', 'LOGISTICS', 'QUALITY', 'FINANCE'];
const SCOPES = ['supplier-orders.read', 'supplier-orders.write'];
const SUPPLIER_RE = /^SUP-[0-9]{6}$/;

// ─── Mappers (DB row -> SRM wire format: nested camelCase, ISO timestamps) ───
const mapContact = (c) => ({ contactId: c.contact_id, role: c.role, name: c.full_name, email: c.email, phone: c.phone });

const mapSite = (s) => ({
  siteCode: s.site_code,
  supplierCode: s.supplier_code,
  type: s.site_type,
  name: s.name,
  address: { line1: s.address_line1, city: s.city, region: s.region, postalCode: s.postal_code, countryCode: s.country },
  active: s.active,
});

function mapSupplier(s, { contacts, sites } = {}) {
  const out = {
    supplierCode: s.supplier_code,
    erpVendorNumber: s.erp_vendor_number,
    name: { legal: s.legal_name, trading: s.trading_name },
    status: s.status,
    statusReason: s.status_reason,
    classification: { tier: s.tier, riskRating: s.risk_rating },
    capabilities: { portal: s.portal_enabled, asn: s.asn_enabled },
    countryCode: s.country,
    duns: s.duns,
    onboardedOn: s.onboarded_on,
    updatedAt: toIso(s.updated_at),
  };
  if (contacts) out.contacts = contacts.map(mapContact);
  if (sites) out.sites = sites.map(mapSite);
  return out;
}

const mapEntitlement = (e) => ({
  consumerId: e.consumer_id,
  displayName: e.display_name,
  consumerType: e.consumer_type,
  allSuppliers: e.supplier_codes.includes('*'),
  suppliers: e.supplier_codes.filter((x) => x !== '*'),
  scopes: e.scopes,
  active: e.active,
  costCenter: e.cost_center,
  contactEmail: e.contact_email,
  updatedAt: toIso(e.updated_at),
});

function assertSupplierCode(v) {
  if (!SUPPLIER_RE.test(v)) {
    throw new ApiError(400, 'INVALID_SUPPLIER_CODE', 'Supplier codes look like SUP-000000', [
      { field: 'supplierCode', message: 'must match ^SUP-[0-9]{6}$' },
    ]);
  }
}

module.exports = function buildSrmRoutes({ pool, idem }) {
  const r = express.Router();

  async function loadSupplier(code) {
    const { rows } = await pool.query('SELECT * FROM srm.suppliers WHERE supplier_code = $1', [code]);
    if (!rows[0]) throw new ApiError(404, 'SUPPLIER_NOT_FOUND', `Supplier ${code} does not exist`);
    return rows[0];
  }

  async function childrenFor(codes, expand) {
    const out = {};
    if (expand.includes('contacts')) {
      out.contacts = (
        await pool.query('SELECT * FROM srm.supplier_contacts WHERE supplier_code = ANY($1) ORDER BY contact_id', [codes])
      ).rows;
    }
    if (expand.includes('sites')) {
      out.sites = (await pool.query('SELECT * FROM srm.supplier_sites WHERE supplier_code = ANY($1) ORDER BY site_code', [codes])).rows;
    }
    return out;
  }

  // ─── Suppliers ───────────────────────────────────────────────────────────
  r.get(
    '/suppliers',
    asyncHandler(async (req, res) => {
      const offset = intParam(req.query.offset, { def: 0, min: 0, max: 1000000, name: 'offset' });
      const limit = intParam(req.query.limit, { def: 20, min: 1, max: 100, name: 'limit' });
      const conds = [];
      const params = [];
      const add = (sql, val) => {
        params.push(val);
        conds.push(sql.replace('?', `$${params.length}`));
      };
      const statuses = csv(req.query.status);
      if (statuses.some((s) => !STATUSES.includes(s))) {
        throw new ApiError(400, 'INVALID_FILTER', `status must be one of ${STATUSES.join(', ')}`, [{ field: 'status', message: 'invalid value' }]);
      }
      if (statuses.length) add('status = ANY(?)', statuses);
      const countries = csv(req.query.country);
      if (countries.length) add('country = ANY(?)', countries);
      const tiers = csv(req.query.tier);
      if (tiers.length) add('tier = ANY(?)', tiers);
      const codes = csv(req.query.supplierCode);
      if (codes.length) add('supplier_code = ANY(?)', codes);
      const vendors = csv(req.query.erpVendorNumber);
      if (vendors.length) add('erp_vendor_number = ANY(?)', vendors);
      if (req.query.q) {
        params.push(`%${req.query.q}%`);
        conds.push(`(legal_name ILIKE $${params.length} OR trading_name ILIKE $${params.length})`);
      }

      const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
      const total = (await pool.query(`SELECT COUNT(*)::int AS n FROM srm.suppliers ${where}`, params)).rows[0].n;
      const { rows } = await pool.query(
        `SELECT * FROM srm.suppliers ${where} ORDER BY supplier_code LIMIT ${limit} OFFSET ${offset}`,
        params
      );
      const expand = csv(req.query.expand);
      const kids = rows.length ? await childrenFor(rows.map((s) => s.supplier_code), expand) : {};
      const items = rows.map((s) =>
        mapSupplier(s, {
          contacts: kids.contacts && kids.contacts.filter((c) => c.supplier_code === s.supplier_code),
          sites: kids.sites && kids.sites.filter((x) => x.supplier_code === s.supplier_code),
        })
      );
      res.json({ total, offset, limit, items });
    })
  );

  r.get(
    '/suppliers/:supplierCode',
    asyncHandler(async (req, res) => {
      assertSupplierCode(req.params.supplierCode);
      const s = await loadSupplier(req.params.supplierCode);
      const expand = req.query.expand !== undefined ? csv(req.query.expand) : ['contacts', 'sites'];
      const kids = await childrenFor([s.supplier_code], expand);
      res.json(mapSupplier(s, kids));
    })
  );

  /** Update master data. Also the demo control to put a supplier on hold / block it (governance failures in the iPaaS). */
  r.patch(
    '/suppliers/:supplierCode',
    asyncHandler(async (req, res) => {
      assertSupplierCode(req.params.supplierCode);
      const b = req.body || {};
      const v = new Validator();
      const status = v.string(b, 'status', { oneOf: STATUSES });
      const statusReason = v.string(b, 'statusReason', { max: 240 });
      const caps = v.object(b, 'capabilities') || {};
      const portal = v.boolean(caps, 'portal', { path: 'capabilities.portal' });
      const asn = v.boolean(caps, 'asn', { path: 'capabilities.asn' });
      const cls = v.object(b, 'classification') || {};
      const tier = v.string(cls, 'tier', { oneOf: TIERS, path: 'classification.tier' });
      const risk = v.string(cls, 'riskRating', { oneOf: RISK, path: 'classification.riskRating' });
      const nm = v.object(b, 'name') || {};
      const legal = v.string(nm, 'legal', { max: 160, path: 'name.legal' });
      const trading = v.string(nm, 'trading', { max: 120, path: 'name.trading' });
      const country = v.string(b, 'countryCode', { pattern: /^[A-Z]{2}$/ });
      const duns = v.string(b, 'duns', { pattern: /^[0-9]{9}$/ });
      const onboarded = v.date(b, 'onboardedOn');
      const erpVendor = v.string(b, 'erpVendorNumber', { pattern: /^[0-9]{10}$/ });
      v.throwIfErrors();
      await loadSupplier(req.params.supplierCode);
      await pool.query(
        `UPDATE srm.suppliers SET legal_name = COALESCE($2, legal_name), trading_name = COALESCE($3, trading_name),
            country = COALESCE($4, country), duns = COALESCE($5, duns), onboarded_on = COALESCE($6, onboarded_on),
            erp_vendor_number = COALESCE($7, erp_vendor_number)
          WHERE supplier_code = $1`,
        [req.params.supplierCode, legal || null, trading || null, country || null, duns || null, onboarded || null, erpVendor || null]
      );
      const clearReason = status === 'ACTIVE' && statusReason === undefined;
      await pool.query(
        `UPDATE srm.suppliers SET
            status = COALESCE($2, status),
            status_reason = CASE WHEN $3::boolean THEN NULL ELSE COALESCE($4, status_reason) END,
            portal_enabled = COALESCE($5, portal_enabled),
            asn_enabled = COALESCE($6, asn_enabled),
            tier = COALESCE($7, tier),
            risk_rating = COALESCE($8, risk_rating),
            updated_at = NOW()
          WHERE supplier_code = $1`,
        [req.params.supplierCode, status || null, clearReason, statusReason || null, portal ?? null, asn ?? null, tier || null, risk || null]
      );
      const s = await loadSupplier(req.params.supplierCode);
      res.json(mapSupplier(s, await childrenFor([s.supplier_code], ['contacts', 'sites'])));
    })
  );

  r.get(
    '/suppliers/:supplierCode/sites',
    asyncHandler(async (req, res) => {
      assertSupplierCode(req.params.supplierCode);
      await loadSupplier(req.params.supplierCode);
      const params = [req.params.supplierCode];
      let extra = '';
      const types = csv(req.query.type);
      if (types.some((t) => !SITE_TYPES.includes(t))) {
        throw new ApiError(400, 'INVALID_FILTER', `type must be one of ${SITE_TYPES.join(', ')}`, [{ field: 'type', message: 'invalid value' }]);
      }
      if (types.length) {
        params.push(types);
        extra += ` AND site_type = ANY($${params.length})`;
      }
      if (req.query.active !== undefined) {
        params.push(String(req.query.active) === 'true');
        extra += ` AND active = $${params.length}`;
      }
      const { rows } = await pool.query(`SELECT * FROM srm.supplier_sites WHERE supplier_code = $1 ${extra} ORDER BY site_code`, params);
      res.json({ total: rows.length, items: rows.map(mapSite) });
    })
  );

  r.get(
    '/suppliers/:supplierCode/contacts',
    asyncHandler(async (req, res) => {
      assertSupplierCode(req.params.supplierCode);
      await loadSupplier(req.params.supplierCode);
      const roles = csv(req.query.role);
      if (roles.some((x) => !ROLES.includes(x))) {
        throw new ApiError(400, 'INVALID_FILTER', `role must be one of ${ROLES.join(', ')}`, [{ field: 'role', message: 'invalid value' }]);
      }
      const { rows } = await pool.query(
        `SELECT * FROM srm.supplier_contacts WHERE supplier_code = $1 ${roles.length ? 'AND role = ANY($2)' : ''} ORDER BY contact_id`,
        roles.length ? [req.params.supplierCode, roles] : [req.params.supplierCode]
      );
      res.json({ total: rows.length, items: rows.map(mapContact) });
    })
  );

  r.get(
    '/sites/:siteCode',
    asyncHandler(async (req, res) => {
      const { rows } = await pool.query('SELECT * FROM srm.supplier_sites WHERE site_code = $1', [req.params.siteCode]);
      if (!rows[0]) throw new ApiError(404, 'SITE_NOT_FOUND', `Site ${req.params.siteCode} does not exist`);
      res.json(mapSite(rows[0]));
    })
  );

  // ─── ERP vendor cross-reference (SUP-xxxxxx <-> 10-digit ERP vendor number) ───
  r.get(
    '/vendor-xref',
    asyncHandler(async (req, res) => {
      const vendors = csv(req.query.erpVendorNumber);
      const codes = csv(req.query.supplierCode);
      if (!vendors.length && !codes.length) {
        throw new ApiError(400, 'FILTER_REQUIRED', 'Provide erpVendorNumber and/or supplierCode (comma separated)', [
          { field: 'erpVendorNumber', message: 'or supplierCode is required' },
        ]);
      }
      const { rows } = await pool.query(
        `SELECT supplier_code, erp_vendor_number, status, legal_name FROM srm.suppliers
          WHERE erp_vendor_number = ANY($1) OR supplier_code = ANY($2) ORDER BY supplier_code`,
        [vendors, codes]
      );
      const found = new Set(rows.flatMap((x) => [x.supplier_code, x.erp_vendor_number]));
      res.json({
        items: rows.map((x) => ({
          supplierCode: x.supplier_code,
          erpVendorNumber: x.erp_vendor_number,
          status: x.status,
          legalName: x.legal_name,
        })),
        unresolved: [...vendors, ...codes].filter((k) => !found.has(k)),
      });
    })
  );

  r.get(
    '/vendor-xref/:erpVendorNumber',
    asyncHandler(async (req, res) => {
      const { rows } = await pool.query(
        'SELECT supplier_code, erp_vendor_number, status, legal_name FROM srm.suppliers WHERE erp_vendor_number = $1',
        [req.params.erpVendorNumber]
      );
      if (!rows[0]) throw new ApiError(404, 'VENDOR_NOT_MAPPED', `ERP vendor ${req.params.erpVendorNumber} has no supplier master record`);
      const x = rows[0];
      res.json({ supplierCode: x.supplier_code, erpVendorNumber: x.erp_vendor_number, status: x.status, legalName: x.legal_name });
    })
  );

  // ─── Consumer entitlements (who may see / act for which supplier) ────────
  r.get(
    '/entitlements',
    asyncHandler(async (req, res) => {
      const params = [];
      let where = '';
      if (req.query.active !== undefined) {
        params.push(String(req.query.active) === 'true');
        where = 'WHERE active = $1';
      }
      const { rows } = await pool.query(`SELECT * FROM srm.consumer_entitlements ${where} ORDER BY consumer_id`, params);
      res.json({ total: rows.length, items: rows.map(mapEntitlement) });
    })
  );

  async function loadEntitlement(id) {
    const { rows } = await pool.query('SELECT * FROM srm.consumer_entitlements WHERE consumer_id = $1', [id]);
    if (!rows[0]) throw new ApiError(404, 'CONSUMER_NOT_FOUND', `Consumer ${id} is not registered`);
    return rows[0];
  }

  r.get(
    '/entitlements/:consumerId',
    asyncHandler(async (req, res) => {
      res.json(mapEntitlement(await loadEntitlement(req.params.consumerId)));
    })
  );

  /** Authorization decision. Always 200 with allowed=true|false (404 only for unknown consumer). */
  const check = asyncHandler(async (req, res) => {
    const input = req.method === 'GET' ? req.query : req.body || {};
    const v = new Validator();
    const scope = v.string(input, 'scope', { required: true, oneOf: SCOPES });
    const supplierCode = v.string(input, 'supplierCode', { pattern: SUPPLIER_RE });
    v.throwIfErrors();
    const e = await loadEntitlement(req.params.consumerId);

    let supplier = null;
    if (supplierCode) {
      const { rows } = await pool.query('SELECT supplier_code, status, asn_enabled FROM srm.suppliers WHERE supplier_code = $1', [supplierCode]);
      supplier = rows[0] || null;
    }

    let allowed = true;
    let reason = 'OK';
    if (!e.active) [allowed, reason] = [false, 'CONSUMER_INACTIVE'];
    else if (!e.scopes.includes(scope)) [allowed, reason] = [false, 'SCOPE_NOT_GRANTED'];
    else if (supplierCode && !supplier) [allowed, reason] = [false, 'SUPPLIER_NOT_FOUND'];
    else if (supplierCode && !e.supplier_codes.includes('*') && !e.supplier_codes.includes(supplierCode)) {
      [allowed, reason] = [false, 'SUPPLIER_SCOPE_DENIED'];
    } else if (supplier && scope === 'supplier-orders.write' && supplier.status !== 'ACTIVE') {
      [allowed, reason] = [false, supplier.status === 'BLOCKED' ? 'SUPPLIER_BLOCKED' : 'SUPPLIER_ON_HOLD'];
    }

    res.json({
      consumerId: e.consumer_id,
      consumerType: e.consumer_type,
      scope,
      supplierCode: supplierCode || null,
      allowed,
      reason,
      allowedSuppliers: e.supplier_codes.includes('*') ? ['*'] : e.supplier_codes,
      evaluatedAt: new Date().toISOString(),
    });
  });
  r.get('/entitlements/:consumerId/check', check);
  r.post('/entitlements/:consumerId/check', check);


  // ═══ Maintenance (CRUD) endpoints used by the dashboard and Postman ═══════

  // ─── Supplier create / delete ────────────────────────────────────────────
  r.post(
    '/suppliers',
    idem,
    asyncHandler(async (req, res) => {
      const b = req.body || {};
      const v = new Validator();
      let code = v.string(b, 'supplierCode', { pattern: SUPPLIER_RE });
      const erpVendor = v.string(b, 'erpVendorNumber', { required: true, pattern: /^[0-9]{10}$/ });
      const nm = v.object(b, 'name', { required: true }) || {};
      const legal = v.string(nm, 'legal', { required: true, max: 160, path: 'name.legal' });
      const trading = v.string(nm, 'trading', { max: 120, path: 'name.trading' });
      const status = v.string(b, 'status', { oneOf: STATUSES }) || 'ACTIVE';
      const statusReason = v.string(b, 'statusReason', { max: 240 });
      const cls = v.object(b, 'classification') || {};
      const tier = v.string(cls, 'tier', { oneOf: TIERS, path: 'classification.tier' }) || 'APPROVED';
      const risk = v.string(cls, 'riskRating', { oneOf: RISK, path: 'classification.riskRating' }) || 'MEDIUM';
      const caps = v.object(b, 'capabilities') || {};
      const portal = v.boolean(caps, 'portal', { path: 'capabilities.portal' });
      const asn = v.boolean(caps, 'asn', { path: 'capabilities.asn' });
      const country = v.string(b, 'countryCode', { required: true, pattern: /^[A-Z]{2}$/ });
      const duns = v.string(b, 'duns', { pattern: /^[0-9]{9}$/ });
      const onboarded = v.date(b, 'onboardedOn') || new Date().toISOString().slice(0, 10);
      v.throwIfErrors();
      if (!code) {
        const { rows } = await pool.query(
          "SELECT 'SUP-' || LPAD((COALESCE(MAX(SUBSTRING(supplier_code, 5)::int), 100000) + 1)::text, 6, '0') AS next FROM srm.suppliers"
        );
        code = rows[0].next;
      }
      await pool.query(
        `INSERT INTO srm.suppliers (supplier_code, erp_vendor_number, legal_name, trading_name, status, status_reason, tier, risk_rating,
            country, duns, portal_enabled, asn_enabled, onboarded_on)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [code, erpVendor, legal, trading || null, status, statusReason || null, tier, risk, country, duns || null, portal ?? true, asn ?? true, onboarded]
      );
      const s = await loadSupplier(code);
      res.status(201).set('Location', `/srm/v1/suppliers/${code}`).json(mapSupplier(s, await childrenFor([code], ['contacts', 'sites'])));
    })
  );

  r.delete(
    '/suppliers/:supplierCode',
    asyncHandler(async (req, res) => {
      assertSupplierCode(req.params.supplierCode);
      await loadSupplier(req.params.supplierCode);
      const { rows } = await pool.query('SELECT consumer_id FROM srm.consumer_entitlements WHERE $1 = ANY(supplier_codes)', [
        req.params.supplierCode,
      ]);
      if (rows.length) {
        throw new ApiError(
          409,
          'SUPPLIER_HAS_ENTITLEMENTS',
          `Supplier is referenced by consumer entitlement(s): ${rows.map((x) => x.consumer_id).join(', ')}. Remove it from those first.`
        );
      }
      await pool.query('DELETE FROM srm.suppliers WHERE supplier_code = $1', [req.params.supplierCode]);
      res.status(204).end();
    })
  );

  // ─── Sites ───────────────────────────────────────────────────────────────
  async function loadSite(code) {
    const { rows } = await pool.query('SELECT * FROM srm.supplier_sites WHERE site_code = $1', [code]);
    if (!rows[0]) throw new ApiError(404, 'SITE_NOT_FOUND', `Site ${code} does not exist`);
    return rows[0];
  }
  function siteFields(v, b, required) {
    const addr = v.object(b, 'address', { required }) || {};
    return {
      type: v.string(b, 'type', { required, oneOf: SITE_TYPES }),
      name: v.string(b, 'name', { required, max: 120 }),
      line1: v.string(addr, 'line1', { max: 120, path: 'address.line1' }),
      city: v.string(addr, 'city', { max: 80, path: 'address.city' }),
      region: v.string(addr, 'region', { max: 80, path: 'address.region' }),
      postalCode: v.string(addr, 'postalCode', { max: 20, path: 'address.postalCode' }),
      countryCode: v.string(addr, 'countryCode', { required, pattern: /^[A-Z]{2}$/, path: 'address.countryCode' }),
      active: v.boolean(b, 'active'),
    };
  }

  r.get(
    '/sites',
    asyncHandler(async (req, res) => {
      const offset = intParam(req.query.offset, { def: 0, min: 0, max: 1000000, name: 'offset' });
      const limit = intParam(req.query.limit, { def: 50, min: 1, max: 200, name: 'limit' });
      const conds = [];
      const params = [];
      const add = (sql, val) => {
        params.push(val);
        conds.push(sql.replace('?', `$${params.length}`));
      };
      const sups = csv(req.query.supplierCode);
      if (sups.length) add('supplier_code = ANY(?)', sups);
      const types = csv(req.query.type);
      if (types.length) add('site_type = ANY(?)', types);
      const countries = csv(req.query.country);
      if (countries.length) add('country = ANY(?)', countries);
      if (req.query.active !== undefined) add('active = ?', String(req.query.active) === 'true');
      const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
      const total = (await pool.query(`SELECT COUNT(*)::int AS n FROM srm.supplier_sites ${where}`, params)).rows[0].n;
      const { rows } = await pool.query(`SELECT * FROM srm.supplier_sites ${where} ORDER BY site_code LIMIT ${limit} OFFSET ${offset}`, params);
      res.json({ total, offset, limit, items: rows.map(mapSite) });
    })
  );

  r.post(
    '/suppliers/:supplierCode/sites',
    idem,
    asyncHandler(async (req, res) => {
      assertSupplierCode(req.params.supplierCode);
      const b = req.body || {};
      const v = new Validator();
      const code = v.string(b, 'siteCode', { required: true, max: 40, pattern: /^[A-Z0-9-]+$/ });
      const f = siteFields(v, b, true);
      v.throwIfErrors();
      await loadSupplier(req.params.supplierCode);
      await pool.query(
        `INSERT INTO srm.supplier_sites (site_code, supplier_code, site_type, name, address_line1, city, region, postal_code, country, active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [code, req.params.supplierCode, f.type, f.name, f.line1 || null, f.city || null, f.region || null, f.postalCode || null, f.countryCode, f.active ?? true]
      );
      res.status(201).set('Location', `/srm/v1/sites/${code}`).json(mapSite(await loadSite(code)));
    })
  );

  r.patch(
    '/sites/:siteCode',
    asyncHandler(async (req, res) => {
      const v = new Validator();
      const f = siteFields(v, req.body || {}, false);
      if (Object.values(f).every((x) => x === undefined)) v.add('body', 'provide at least one site field');
      v.throwIfErrors();
      await loadSite(req.params.siteCode);
      await pool.query(
        `UPDATE srm.supplier_sites SET site_type = COALESCE($2, site_type), name = COALESCE($3, name),
            address_line1 = COALESCE($4, address_line1), city = COALESCE($5, city), region = COALESCE($6, region),
            postal_code = COALESCE($7, postal_code), country = COALESCE($8, country), active = COALESCE($9, active)
          WHERE site_code = $1`,
        [req.params.siteCode, f.type || null, f.name || null, f.line1 || null, f.city || null, f.region || null, f.postalCode || null,
          f.countryCode || null, f.active ?? null]
      );
      res.json(mapSite(await loadSite(req.params.siteCode)));
    })
  );

  r.delete(
    '/sites/:siteCode',
    asyncHandler(async (req, res) => {
      await loadSite(req.params.siteCode);
      await pool.query('DELETE FROM srm.supplier_sites WHERE site_code = $1', [req.params.siteCode]);
      res.status(204).end();
    })
  );

  // ─── Contacts ────────────────────────────────────────────────────────────
  async function loadContact(id) {
    const { rows } = await pool.query('SELECT * FROM srm.supplier_contacts WHERE contact_id = $1', [id]);
    if (!rows[0]) throw new ApiError(404, 'CONTACT_NOT_FOUND', `Contact ${id} does not exist`);
    return rows[0];
  }
  const mapContactFull = (c) => ({ ...mapContact(c), supplierCode: c.supplier_code });
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  r.get(
    '/contacts',
    asyncHandler(async (req, res) => {
      const offset = intParam(req.query.offset, { def: 0, min: 0, max: 1000000, name: 'offset' });
      const limit = intParam(req.query.limit, { def: 50, min: 1, max: 200, name: 'limit' });
      const conds = [];
      const params = [];
      const sups = csv(req.query.supplierCode);
      if (sups.length) {
        params.push(sups);
        conds.push(`supplier_code = ANY($${params.length})`);
      }
      const roles = csv(req.query.role);
      if (roles.length) {
        params.push(roles);
        conds.push(`role = ANY($${params.length})`);
      }
      if (req.query.q) {
        params.push(`%${req.query.q}%`);
        conds.push(`(full_name ILIKE $${params.length} OR email ILIKE $${params.length})`);
      }
      const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
      const total = (await pool.query(`SELECT COUNT(*)::int AS n FROM srm.supplier_contacts ${where}`, params)).rows[0].n;
      const { rows } = await pool.query(
        `SELECT * FROM srm.supplier_contacts ${where} ORDER BY contact_id LIMIT ${limit} OFFSET ${offset}`,
        params
      );
      res.json({ total, offset, limit, items: rows.map(mapContactFull) });
    })
  );

  r.get(
    '/contacts/:contactId',
    asyncHandler(async (req, res) => {
      res.json(mapContactFull(await loadContact(req.params.contactId)));
    })
  );

  r.post(
    '/suppliers/:supplierCode/contacts',
    idem,
    asyncHandler(async (req, res) => {
      assertSupplierCode(req.params.supplierCode);
      const b = req.body || {};
      const v = new Validator();
      const role = v.string(b, 'role', { required: true, oneOf: ROLES });
      const name = v.string(b, 'name', { required: true, max: 120 });
      const email = v.string(b, 'email', { required: true, max: 160, pattern: EMAIL_RE });
      const phone = v.string(b, 'phone', { max: 40 });
      v.throwIfErrors();
      await loadSupplier(req.params.supplierCode);
      const { rows } = await pool.query(
        "SELECT 'CNT-' || LPAD((COALESCE(MAX(SUBSTRING(contact_id, 5)::int), 0) + 1)::text, 4, '0') AS next FROM srm.supplier_contacts WHERE contact_id ~ '^CNT-[0-9]+$'"
      );
      const id = rows[0].next;
      await pool.query(
        'INSERT INTO srm.supplier_contacts (contact_id, supplier_code, role, full_name, email, phone) VALUES ($1,$2,$3,$4,$5,$6)',
        [id, req.params.supplierCode, role, name, email, phone || null]
      );
      res.status(201).set('Location', `/srm/v1/contacts/${id}`).json(mapContactFull(await loadContact(id)));
    })
  );

  r.patch(
    '/contacts/:contactId',
    asyncHandler(async (req, res) => {
      const b = req.body || {};
      const v = new Validator();
      const role = v.string(b, 'role', { oneOf: ROLES });
      const name = v.string(b, 'name', { max: 120 });
      const email = v.string(b, 'email', { max: 160, pattern: EMAIL_RE });
      const phone = v.string(b, 'phone', { max: 40 });
      if (!role && !name && !email && phone === undefined) v.add('body', 'provide role, name, email and/or phone');
      v.throwIfErrors();
      await loadContact(req.params.contactId);
      await pool.query(
        `UPDATE srm.supplier_contacts SET role = COALESCE($2, role), full_name = COALESCE($3, full_name),
            email = COALESCE($4, email), phone = COALESCE($5, phone) WHERE contact_id = $1`,
        [req.params.contactId, role || null, name || null, email || null, phone || null]
      );
      res.json(mapContactFull(await loadContact(req.params.contactId)));
    })
  );

  r.delete(
    '/contacts/:contactId',
    asyncHandler(async (req, res) => {
      await loadContact(req.params.contactId);
      await pool.query('DELETE FROM srm.supplier_contacts WHERE contact_id = $1', [req.params.contactId]);
      res.status(204).end();
    })
  );

  // ─── Entitlement create / update / delete ────────────────────────────────
  const CONSUMER_TYPES = ['supplier-partner', 'internal-application', 'operations-support'];
  async function validateSuppliers(v, list) {
    if (!list) return;
    const bad = list.filter((x) => x !== '*' && !SUPPLIER_RE.test(x));
    if (bad.length) return void v.add('suppliers', `invalid supplier code(s): ${bad.join(', ')}`);
    const codes = list.filter((x) => x !== '*');
    if (!codes.length) return;
    const { rows } = await pool.query('SELECT supplier_code FROM srm.suppliers WHERE supplier_code = ANY($1)', [codes]);
    const missing = codes.filter((c) => !rows.some((x) => x.supplier_code === c));
    if (missing.length) v.add('suppliers', `unknown supplier(s): ${missing.join(', ')}`);
  }
  function entitlementFields(v, b, required) {
    const scopes = v.array(b, 'scopes', { required, minItems: 1 });
    if (scopes && scopes.some((x) => !SCOPES.includes(x))) v.add('scopes', `each scope must be one of ${SCOPES.join(', ')}`);
    const suppliers = v.array(b, 'suppliers');
    const all = v.boolean(b, 'allSuppliers');
    return {
      displayName: v.string(b, 'displayName', { required, max: 160 }),
      consumerType: v.string(b, 'consumerType', { required, oneOf: CONSUMER_TYPES }),
      scopes,
      suppliers,
      all,
      active: v.boolean(b, 'active'),
      costCenter: v.string(b, 'costCenter', { max: 40 }),
      contactEmail: v.string(b, 'contactEmail', { max: 160, pattern: EMAIL_RE }),
    };
  }
  const supplierList = (f, fallback) => (f.all ? ['*'] : f.suppliers !== undefined ? f.suppliers : fallback);

  r.post(
    '/entitlements',
    idem,
    asyncHandler(async (req, res) => {
      const b = req.body || {};
      const v = new Validator();
      const id = v.string(b, 'consumerId', { required: true, max: 80, pattern: /^[a-z0-9][a-z0-9-]*$/ });
      const f = entitlementFields(v, b, true);
      const list = supplierList(f, []);
      if (!list.length) v.add('suppliers', 'grant at least one supplier or set allSuppliers=true');
      await validateSuppliers(v, list);
      v.throwIfErrors();
      await pool.query(
        `INSERT INTO srm.consumer_entitlements (consumer_id, display_name, consumer_type, supplier_codes, scopes, active, cost_center, contact_email)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [id, f.displayName, f.consumerType, list, f.scopes, f.active ?? true, f.costCenter || null, f.contactEmail || null]
      );
      res.status(201).set('Location', `/srm/v1/entitlements/${id}`).json(mapEntitlement(await loadEntitlement(id)));
    })
  );

  r.patch(
    '/entitlements/:consumerId',
    asyncHandler(async (req, res) => {
      const v = new Validator();
      const f = entitlementFields(v, req.body || {}, false);
      const cur = await loadEntitlement(req.params.consumerId);
      const list = supplierList(f, cur.supplier_codes);
      if (f.all === false && f.suppliers === undefined) v.add('suppliers', 'provide suppliers when setting allSuppliers=false');
      if (!list.length) v.add('suppliers', 'grant at least one supplier or set allSuppliers=true');
      await validateSuppliers(v, f.suppliers);
      v.throwIfErrors();
      await pool.query(
        `UPDATE srm.consumer_entitlements SET display_name = COALESCE($2, display_name), consumer_type = COALESCE($3, consumer_type),
            supplier_codes = $4, scopes = COALESCE($5, scopes), active = COALESCE($6, active),
            cost_center = COALESCE($7, cost_center), contact_email = COALESCE($8, contact_email), updated_at = NOW()
          WHERE consumer_id = $1`,
        [req.params.consumerId, f.displayName || null, f.consumerType || null, list, f.scopes || null, f.active ?? null,
          f.costCenter || null, f.contactEmail || null]
      );
      res.json(mapEntitlement(await loadEntitlement(req.params.consumerId)));
    })
  );

  r.delete(
    '/entitlements/:consumerId',
    asyncHandler(async (req, res) => {
      await loadEntitlement(req.params.consumerId);
      await pool.query('DELETE FROM srm.consumer_entitlements WHERE consumer_id = $1', [req.params.consumerId]);
      res.status(204).end();
    })
  );

  return r;
};
