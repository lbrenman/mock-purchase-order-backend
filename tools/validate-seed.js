#!/usr/bin/env node
'use strict';
/**
 * Cross-system consistency check for src/data/{erp,srm,tms}.json. No database needed.
 *
 *   node tools/validate-seed.js        # or: npm run validate:seed
 *
 * Exits 1 with a list of problems if any rule is broken. Rules:
 *  - POs reference existing vendors (SRM), plants and purchasing orgs (ERP)
 *  - item shipped_qty = sum of POSTED inbound deliveries; confirmed/shipped <= ordered
 *  - PO status matches the ERP recompute rule (05/09 are manual)
 *  - one confirmation per PO revision
 *  - every inbound delivery has a TMS shipment with the same supplier + ASN and identical contents;
 *    REVERSED deliveries <-> CXL shipments; every tendered/moving shipment has a delivery
 *  - unique IDs, known carriers, entitlement suppliers exist
 *  - nothing dated after the seed "today" (2026-09-24T12:00:00Z); events in chronological order
 *  - seeded IDs below the runtime sequences (confirmations < 7100000101, deliveries < 180000201,
 *    shipment suffix < 00200)
 */
const path = require('path');
const dir = path.join(__dirname, '..', 'src', 'data');
const erp = require(path.join(dir, 'erp.json'));
const srm = require(path.join(dir, 'srm.json'));
const tms = require(path.join(dir, 'tms.json'));

const TODAY = '2026-09-24T12:00:00Z';
const errors = [];
const fail = (msg) => errors.push(msg);
const dupes = (arr) => arr.filter((x, i) => arr.indexOf(x) !== i);

const vendors = new Map(srm.suppliers.map((s) => [s.erp_vendor_number, s]));
const supplierCodes = new Set(srm.suppliers.map((s) => s.supplier_code));
const plants = new Set(erp.plants.map((p) => p.plant_code));
const orgs = new Set(erp.purchasing_orgs.map((o) => o.code));
const scacs = new Set(tms.carriers.map((c) => c.scac));

dupes(erp.purchase_orders.map((p) => p.po_number)).forEach((x) => fail(`duplicate PO ${x}`));
dupes(srm.suppliers.map((s) => s.supplier_code)).forEach((x) => fail(`duplicate supplier ${x}`));
dupes(srm.suppliers.map((s) => s.erp_vendor_number)).forEach((x) => fail(`duplicate vendor number ${x}`));
dupes(srm.sites.map((s) => s.site_code)).forEach((x) => fail(`duplicate site ${x}`));
dupes(srm.contacts.map((c) => c.contact_id)).forEach((x) => fail(`duplicate contact ${x}`));
dupes(tms.shipments.map((s) => s.shipment_id)).forEach((x) => fail(`duplicate shipment ${x}`));
dupes(tms.shipments.map((s) => `${s.supplier_code}|${s.asn_number}`)).forEach((x) => fail(`duplicate supplier ASN ${x}`));
dupes(erp.confirmations.map((c) => `${c.po_number}|${c.po_revision}`)).forEach((x) => fail(`two confirmations for revision ${x}`));

// shipped quantities from POSTED deliveries
const shipped = new Map();
for (const d of erp.inbound_deliveries) {
  if (!vendors.has(d.vendor_id)) fail(`delivery ${d.delivery_no}: vendor ${d.vendor_id} not in SRM`);
  if (d.status !== 'POSTED') continue;
  for (const i of d.items) shipped.set(`${i.po_number}|${i.item_no}`, (shipped.get(`${i.po_number}|${i.item_no}`) || 0) + Number(i.quantity));
}

for (const p of erp.purchase_orders) {
  if (!vendors.has(p.vendor_id)) fail(`PO ${p.po_number}: vendor ${p.vendor_id} not in SRM`);
  if (!plants.has(p.plant)) fail(`PO ${p.po_number}: unknown plant ${p.plant}`);
  if (!orgs.has(p.purch_org)) fail(`PO ${p.po_number}: unknown purch org ${p.purch_org}`);
  if (p.changed_at > TODAY || p.created_at > TODAY) fail(`PO ${p.po_number}: dated in the future`);
  for (const i of p.items) {
    const s = shipped.get(`${p.po_number}|${i.item_no}`) || 0;
    if (Math.abs(s - Number(i.shipped_qty || 0)) > 1e-6) fail(`PO ${p.po_number}/${i.item_no}: shipped_qty ${i.shipped_qty || 0} but POSTED deliveries total ${s}`);
    if (Number(i.confirmed_qty || 0) > i.quantity) fail(`PO ${p.po_number}/${i.item_no}: over-confirmed`);
    if (Number(i.shipped_qty || 0) > i.quantity) fail(`PO ${p.po_number}/${i.item_no}: over-shipped`);
  }
  if (!['05', '09'].includes(p.status_code)) {
    let st = '01';
    if (p.items.some((i) => Number(i.shipped_qty || 0) > 0)) st = '04';
    else if (p.items.every((i) => Number(i.confirmed_qty || 0) >= i.quantity)) st = '03';
    else if (p.items.some((i) => Number(i.confirmed_qty || 0) > 0)) st = '02';
    if (st !== p.status_code) fail(`PO ${p.po_number}: status ${p.status_code} but recompute gives ${st}`);
  }
}
const poNumbers = new Set(erp.purchase_orders.map((p) => p.po_number));
for (const c of erp.confirmations) {
  if (!poNumbers.has(c.po_number)) fail(`confirmation ${c.confirmation_no}: unknown PO ${c.po_number}`);
  if (Number(c.confirmation_no) >= 7100000101) fail(`confirmation ${c.confirmation_no} collides with the runtime sequence`);
}

// ERP deliveries <-> TMS shipments
const byAsn = new Map(tms.shipments.map((s) => [`${s.supplier_code}|${s.asn_number}`, s]));
const matched = new Set();
const norm = (rows) => JSON.stringify(rows.sort());
for (const d of erp.inbound_deliveries) {
  if (Number(d.delivery_no) >= 180000201) fail(`delivery ${d.delivery_no} collides with the runtime sequence`);
  const v = vendors.get(d.vendor_id);
  const s = v && byAsn.get(`${v.supplier_code}|${d.asn_reference}`);
  if (!s) { fail(`delivery ${d.delivery_no}: no TMS shipment for ${d.asn_reference}`); continue; }
  matched.add(s.shipment_id);
  const a = norm(d.items.map((i) => `${i.po_number}|${Number(i.item_no)}|${Number(i.quantity)}`));
  const b = norm(s.contents.map((c) => `${c.poNumber}|${c.poLine}|${Number(c.quantity.value)}`));
  if (a !== b) fail(`delivery ${d.delivery_no} and shipment ${s.shipment_id}: contents differ`);
  if ((d.status === 'REVERSED') !== (s.milestone === 'CXL')) fail(`delivery ${d.delivery_no} is ${d.status} but shipment ${s.shipment_id} is ${s.milestone}`);
}
for (const s of tms.shipments) {
  if (!supplierCodes.has(s.supplier_code)) fail(`shipment ${s.shipment_id}: unknown supplier ${s.supplier_code}`);
  if (!scacs.has(s.carrier_scac)) fail(`shipment ${s.shipment_id}: unknown SCAC ${s.carrier_scac}`);
  if (Number(s.shipment_id.slice(-5)) >= 200) fail(`shipment ${s.shipment_id} collides with the runtime sequence`);
  if (s.created_at > TODAY) fail(`shipment ${s.shipment_id}: created in the future`);
  for (const c of s.contents) if (!poNumbers.has(c.poNumber)) fail(`shipment ${s.shipment_id}: unknown PO ${c.poNumber}`);
  const times = s.events.map((e) => e.occurred_at);
  if (times.some((t) => t > TODAY)) fail(`shipment ${s.shipment_id}: event in the future`);
  if (JSON.stringify(times) !== JSON.stringify([...times].sort())) fail(`shipment ${s.shipment_id}: events out of order`);
  if (!['PLN'].includes(s.milestone) && !matched.has(s.shipment_id)) fail(`shipment ${s.shipment_id} (${s.milestone}) has no ERP inbound delivery`);
}
for (const e of srm.entitlements) {
  for (const c of e.supplier_codes) if (c !== '*' && !supplierCodes.has(c)) fail(`entitlement ${e.consumer_id}: unknown supplier ${c}`);
}
for (const x of [...srm.sites, ...srm.contacts]) if (!supplierCodes.has(x.supplier_code)) fail(`${x.site_code || x.contact_id}: unknown supplier ${x.supplier_code}`);

const summary = `${srm.suppliers.length} suppliers, ${erp.purchase_orders.length} POs, ${erp.confirmations.length} confirmations, ` +
  `${erp.inbound_deliveries.length} deliveries, ${tms.shipments.length} shipments, ${tms.shipments.reduce((a, s) => a + s.events.length, 0)} events`;
if (errors.length) {
  console.error(`Seed data has ${errors.length} problem(s):\n  - ${errors.join('\n  - ')}`);
  process.exit(1);
}
console.log(`Seed data is consistent: ${summary}`);
