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

module.exports = function buildSrmRoutes({ pool }) {
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

  /** Demo control: put a supplier on hold / block it to show governance failures in the iPaaS. */
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
      v.throwIfErrors();
      await loadSupplier(req.params.supplierCode);
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

  return r;
};
