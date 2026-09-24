#!/usr/bin/env node
'use strict';

/**
 * Smoke test + "orchestration by hand" walkthrough.
 *
 *   npm run smoke                       read-only checks against http://localhost:3000
 *   npm run smoke -- --write            also runs the createASN saga and then compensates it
 *   BASE_URL=https://x.ngrok-free.app npm run smoke
 *
 * In separate mode set ERP_URL / SRM_URL / TMS_URL (e.g. http://localhost:3001/erp).
 * Requires Node 20+ (global fetch).
 */

require('dotenv').config();

const BASE = (process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, '');
const URLS = {
  erp: process.env.ERP_URL || `${BASE}/erp`,
  srm: process.env.SRM_URL || `${BASE}/srm`,
  tms: process.env.TMS_URL || `${BASE}/tms`,
};
const KEYS = {
  erp: process.env.ERP_API_KEY || 'erp-demo-key',
  srm: process.env.SRM_API_KEY || 'srm-demo-key',
  tms: process.env.TMS_API_KEY || 'tms-demo-key',
};
const WRITE = process.argv.includes('--write');

let passed = 0;
let failed = 0;

async function call(svc, method, path, { body, headers = {}, key = KEYS[svc] } = {}) {
  const res = await fetch(`${URLS[svc]}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'ngrok-skip-browser-warning': 'true',
      'x-correlation-id': `smoke-${Date.now()}`,
      ...(key ? { 'x-api-key': key } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, headers: res.headers, body: json };
}

function check(name, cond, extra) {
  if (cond) {
    passed += 1;
    console.log(`  ✔ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✖ ${name}${extra ? `\n      ${JSON.stringify(extra).slice(0, 400)}` : ''}`);
  }
}

async function main() {
  console.log(`\nTarget: ERP ${URLS.erp} | SRM ${URLS.srm} | TMS ${URLS.tms}\n`);

  console.log('Health');
  for (const svc of ['erp', 'srm', 'tms']) {
    const r = await call(svc, 'GET', '/health', { key: null });
    check(`${svc} /health -> ${r.status} (${r.body && r.body.database})`, r.status === 200, r.body);
  }

  console.log('\nSecurity');
  const noKey = await call('erp', 'GET', '/v1/purchase-orders', { key: null });
  check(`ERP without key -> ${noKey.status} (401 expected unless AUTH_MODE=none)`, [200, 401].includes(noKey.status));

  console.log('\nGET /purchase-orders?supplierId=SUP-100245 (aggregation, by hand)');
  const ent = await call('srm', 'GET', '/v1/entitlements/apex-supplier-portal/check?scope=supplier-orders.read&supplierCode=SUP-100245');
  check(`1. SRM entitlement check -> allowed=${ent.body && ent.body.allowed}`, ent.body && ent.body.allowed === true, ent.body);
  const xref = await call('srm', 'GET', '/v1/vendor-xref?supplierCode=SUP-100245');
  const vendor = xref.body && xref.body.items && xref.body.items[0] && xref.body.items[0].erpVendorNumber;
  check(`2. SRM xref SUP-100245 -> vendor ${vendor}`, vendor === '0000710245', xref.body);
  const list = await call('erp', 'GET', `/v1/purchase-orders?vendor_id=${vendor}&include=items`);
  check(`3. ERP POs for vendor -> ${list.body && list.body.pagination && list.body.pagination.total} found`, list.status === 200, list.body);
  const po = list.body && list.body.data && list.body.data.find((p) => p.po_number === '4500123456');
  check('   PO 4500123456 present with items', po && po.items && po.items.length > 0, po);
  const plant = await call('erp', 'GET', `/v1/plants/${po ? po.plant : '1101'}`);
  check(`4. ERP plant ${po && po.plant} -> site ${plant.body && plant.body.data && plant.body.data.site_code}`, plant.status === 200, plant.body);
  const orgs = await call('erp', 'GET', '/v1/reference/purchasing-orgs');
  const org = orgs.body && orgs.body.data && orgs.body.data.find((o) => po && o.code === po.purch_org);
  check(`5. ERP purch_org ${po && po.purch_org} -> ${org && org.name}`, !!org, orgs.body);

  console.log('\nNegative paths the façade must translate');
  const denied = await call('srm', 'GET', '/v1/entitlements/apex-supplier-portal/check?scope=supplier-orders.read&supplierCode=SUP-100311');
  check(`SRM foreign supplier -> reason ${denied.body && denied.body.reason} (→ 403 SUPPLIER_SCOPE_DENIED)`, denied.body && denied.body.reason === 'SUPPLIER_SCOPE_DENIED');
  const badPo = await call('erp', 'GET', '/v1/purchase-orders/PO-4500123456');
  check(`ERP with façade id PO-4500123456 -> ${badPo.status} ${badPo.body && badPo.body.error && badPo.body.error.code}`, badPo.status === 400);
  const missing = await call('tms', 'GET', '/v1/shipments/SHP-20990101-99999');
  check(`TMS unknown shipment -> ${missing.status} ${missing.body && missing.body.fault && missing.body.fault.faultCode}`, missing.status === 404);
  const carriers = await call('tms', 'GET', '/v1/carriers?code=UPS');
  const scac = carriers.body && carriers.body.results && carriers.body.results[0] && carriers.body.results[0].scac;
  check(`TMS carrier map UPS -> ${scac}`, scac === 'UPSN');
  const chaos = await call('tms', 'GET', '/v1/carriers', { headers: { 'x-mock-status': '503' } });
  check(`Chaos header x-mock-status: 503 -> ${chaos.status} (503 when CHAOS_ENABLED)`, [200, 503].includes(chaos.status));

  console.log('\nGET /shipments/{id} (single backend + reshaping)');
  const shp = await call('tms', 'GET', '/v1/shipments/SHP-20260918-00121?include=events');
  check(`TMS shipment milestone ${shp.body && shp.body.milestone && shp.body.milestone.code} (→ IN_TRANSIT)`, shp.status === 200, shp.body);

  if (!WRITE) {
    console.log('\n(skipping write saga — run with --write to exercise createASN + compensation)');
  } else {
    console.log('\nPOST /shipments saga (createASN) with compensation');
    const asn = `ASN-SMOKE-${Date.now()}`;
    const openBefore = await call('erp', 'GET', '/v1/purchase-orders/4500123456/items');
    const openQty = openBefore.body && openBefore.body.data && openBefore.body.data[0] && openBefore.body.data[0].open_qty;
    check(`ERP open qty line 00010 = ${openQty}`, openBefore.status === 200);

    const tms = await call('tms', 'POST', '/v1/shipments', {
      headers: { 'idempotency-key': `${asn}-tms` },
      body: {
        asnNumber: asn,
        supplierCode: 'SUP-100245',
        carrier: { scac: 'UPSN', trackingId: '1Z999AA10123456784' },
        route: {
          origin: { locationCode: 'SUP-ATL-01', name: 'Supplier Distribution Center', city: 'Atlanta', state: 'GA', zip: '30301', country: 'US' },
          destination: { locationCode: 'US-AUBURN-HILLS', name: 'Jabil Manufacturing Site', city: 'Auburn Hills', state: 'MI', zip: '48326', country: 'US' },
        },
        schedule: { plannedShipDate: '2026-10-03T12:00:00Z', estimatedArrival: '2026-10-07T15:00:00Z' },
        contents: [{ poNumber: '4500123456', poLine: 10, quantity: { value: 5, uom: 'EA' }, lotNumber: 'LOT-SMOKE' }],
        handlingUnits: [{ huId: 'CTN-SMOKE-1', type: 'CTN', weight: { value: 12, unit: 'kg' } }],
      },
    });
    const shipmentId = tms.body && tms.body.shipmentId;
    check(`TMS create -> ${tms.status} ${shipmentId}`, tms.status === 201, tms.body);

    const del = await call('erp', 'POST', '/v1/inbound-deliveries', {
      headers: { 'idempotency-key': `${asn}-erp` },
      body: { asn_reference: shipmentId || asn, vendor_id: '0000710245', items: [{ po_number: '4500123456', item_no: '00010', quantity: 5 }] },
    });
    const deliveryNo = del.body && del.body.data && del.body.data.delivery_no;
    check(`ERP inbound delivery -> ${del.status} ${deliveryNo}`, del.status === 201, del.body);

    const over = await call('erp', 'POST', '/v1/inbound-deliveries', {
      body: { asn_reference: `${asn}-X`, vendor_id: '0000710245', items: [{ po_number: '4500123456', item_no: '00010', quantity: 999999 }] },
    });
    check(`ERP over-shipment -> ${over.status} ${over.body && over.body.error && over.body.error.code}`, over.status === 422);

    console.log('  compensating...');
    if (deliveryNo) {
      const rev = await call('erp', 'POST', `/v1/inbound-deliveries/${deliveryNo}/reverse`, { body: { reason: 'smoke test cleanup' } });
      check(`ERP reverse ${deliveryNo} -> ${rev.status}`, rev.status === 200, rev.body);
    }
    if (shipmentId) {
      const cxl = await call('tms', 'POST', `/v1/shipments/${shipmentId}/cancel`, { body: { reason: 'smoke test cleanup' } });
      check(`TMS cancel ${shipmentId} -> ${cxl.body && cxl.body.milestone && cxl.body.milestone.code}`, cxl.status === 200, cxl.body);
    }
    const openAfter = await call('erp', 'GET', '/v1/purchase-orders/4500123456/items');
    const after = openAfter.body && openAfter.body.data && openAfter.body.data[0] && openAfter.body.data[0].open_qty;
    check(`ERP open qty restored (${after})`, after === openQty);
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((err) => {
  console.error(`\n✖ ${err.message}\n  Is the server running at ${BASE}?`);
  process.exitCode = 1;
});
