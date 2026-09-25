// Memoised lookups shared by several pages. invalidate() after writes.
import { get, erpAll, srmAll, tmsAll } from './api.js';

const memo = new Map();
function once(key, fn) {
  if (!memo.has(key)) memo.set(key, fn().catch((err) => { memo.delete(key); throw err; }));
  return memo.get(key);
}
export const invalidate = (...keys) => (keys.length ? keys.forEach((k) => memo.delete(k)) : memo.clear());

export const plants = () => once('plants', () => get('erp', '/v1/plants').then((r) => r.data));
export const purchOrgs = () => once('orgs', () => get('erp', '/v1/reference/purchasing-orgs').then((r) => r.data));
export const suppliers = () => once('suppliers', () => srmAll('/v1/suppliers'));
export const carriers = () => once('carriers', () => get('tms', '/v1/carriers').then((r) => r.results));
export const eventCodes = () => once('eventCodes', () => get('tms', '/v1/event-codes').then((r) => r.results));
export const allPos = () => once('pos', () => erpAll('/v1/purchase-orders'));
export const allShipments = () => once('shipments', () => tmsAll('/v1/shipments'));

/** vendor_id -> supplier (SRM) using the batch cross-reference endpoint. Unresolved vendors map to null. */
const xrefCache = new Map();
export async function vendorsToSuppliers(vendorIds) {
  const missing = [...new Set(vendorIds)].filter((v) => v && !xrefCache.has(v));
  if (missing.length) {
    try {
      const r = await get('srm', '/v1/vendor-xref', { erpVendorNumber: missing.join(',') });
      for (const x of r.items) xrefCache.set(x.erpVendorNumber, x);
      for (const u of r.unresolved) xrefCache.set(u, null);
    } catch {
      /* SRM down: leave vendors unresolved, the page still renders ERP data */
    }
  }
  return Object.fromEntries(vendorIds.map((v) => [v, xrefCache.get(v) || null]));
}
export const clearXref = () => xrefCache.clear();

export const supplierOptions = async ({ activeOnly = false, withVendor = false } = {}) =>
  (await suppliers())
    .filter((s) => !activeOnly || s.status === 'ACTIVE')
    .map((s) => ({ value: withVendor ? s.erpVendorNumber : s.supplierCode, label: `${s.name.trading || s.name.legal} (${s.supplierCode})${s.status !== 'ACTIVE' ? `, ${s.status.toLowerCase().replace('_', ' ')}` : ''}` }));
