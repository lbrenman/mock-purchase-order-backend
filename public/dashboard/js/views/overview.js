import { get, isEnabled } from '../api.js';
import { h, mount, table, badge, fmtDate, fmtDateTime, relative, errorText } from '../ui.js';
import * as cache from '../cache.js';
import { link } from './common.js';
import { STATUS as PO_STATUS } from './erp.js';
import { MILESTONES } from './tms.js';

const SUPPLIER_STATUS = { ACTIVE: 'Active', ON_HOLD: 'On hold', BLOCKED: 'Blocked' };

function lane(sys, title, note, entries, pageId, param) {
  const max = Math.max(1, ...entries.map((e) => e.n));
  return h('div', { class: 'lane', 'data-sys': sys },
    h('div', { class: 'lane-head' }, title, h('small', null, note)),
    h('div', { class: 'stages', style: { '--n': String(entries.length) } }, entries.map((e) =>
      h('a', { class: 'stage', href: `#/${pageId}?${param}=${encodeURIComponent(e.code)}` },
        h('div', { class: 'n' }, String(e.n)),
        h('div', { class: 'lbl' }, e.label),
        h('div', { class: 'code' }, e.code),
        h('span', { class: 'bar', style: { width: `${Math.round((e.n / max) * 100)}%` } })))));
}

const failed = (sys, err) => h('div', { class: 'lane', 'data-sys': sys }, h('div', { class: 'lane-head' }, sys.toUpperCase()), h('div', { class: 'form-error' }, errorText(err)));

export const overviewPage = {
  id: 'overview',
  sys: null,
  nav: 'Overview',
  title: 'Overview',
  async render(main) {
    mount(main, h('p', { class: 'muted' }, h('span', { class: 'spinner' }), ' Reading all three backends…'));
    cache.invalidate('pos', 'shipments', 'suppliers');
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const [pos, shipments, suppliers, review] = await Promise.allSettled([
      isEnabled('erp') ? cache.allPos() : Promise.reject(new Error('ERP backend disabled')),
      isEnabled('tms') ? cache.allShipments() : Promise.reject(new Error('TMS backend disabled')),
      isEnabled('srm') ? cache.suppliers() : Promise.reject(new Error('SRM backend disabled')),
      isEnabled('erp') ? get('erp', '/v1/confirmations', { status: 'IN_REVIEW', limit: 50 }) : Promise.reject(new Error('ERP backend disabled')),
    ]);

    const lanes = [];
    if (pos.status === 'fulfilled') {
      lanes.push(lane('erp', 'Purchase orders', `${pos.value.length} in ERP`, Object.entries(PO_STATUS).map(([code, label]) => ({ code, label, n: pos.value.filter((p) => p.status_code === code).length })), 'erp/purchase-orders', 'status'));
    } else lanes.push(failed('erp', pos.reason));
    if (shipments.status === 'fulfilled') {
      lanes.push(lane('tms', 'Shipments', `${shipments.value.length} in TMS`, Object.entries(MILESTONES).map(([code, label]) => ({ code, label, n: shipments.value.filter((s) => s.milestone.code === code).length })), 'tms/shipments', 'status'));
    } else lanes.push(failed('tms', shipments.reason));
    if (suppliers.status === 'fulfilled') {
      lanes.push(lane('srm', 'Suppliers', `${suppliers.value.length} in SRM`, Object.entries(SUPPLIER_STATUS).map(([code, label]) => ({ code, label, n: suppliers.value.filter((s) => s.status === code).length })), 'srm/suppliers', 'status'));
    } else lanes.push(failed('srm', suppliers.reason));

    const panels = [];
    if (shipments.status === 'fulfilled') {
      const exc = shipments.value.filter((s) => s.milestone.code === 'EXC');
      panels.push(h('div', { class: 'panel' },
        h('h2', null, 'Shipment exceptions'),
        h('p', { class: 'note' }, 'TMS milestone EXC. The façade reports these as shipment status EXCEPTION.'),
        h('div', { class: 'scroll' }, table([
          { label: 'Shipment', render: (s) => link('tms/shipments', s.shipmentId, s.shipmentId, 'id') },
          { label: 'Supplier', render: (s) => h('span', { class: 'mono' }, s.supplierCode) },
          { label: 'Since', render: (s) => relative(s.milestone.since) },
          { label: 'ETA', render: (s) => fmtDate(s.schedule.estimatedArrival) },
        ], exc, { empty: { title: 'No exceptions', text: 'Every shipment is moving.' } }))));
    }
    if (review.status === 'fulfilled') {
      panels.push(h('div', { class: 'panel' },
        h('h2', null, 'Confirmations waiting for buyer review'),
        h('p', { class: 'note' }, 'Accepted-with-changes acknowledgements (AC) that reduced quantity or moved the date.'),
        h('div', { class: 'scroll' }, table([
          { label: 'Confirmation', render: (c) => link('erp/confirmations', c.confirmation_no, c.confirmation_no, 'id') },
          { label: 'PO', render: (c) => link('erp/purchase-orders', c.po_number, c.po_number, 'mono') },
          { label: 'Supplier ref', render: (c) => c.vendor_reference },
          { label: 'Posted', render: (c) => fmtDateTime(c.posted_at) },
        ], review.value.data, { empty: { title: 'Nothing to review', text: 'All confirmations are posted.' } }))));
    }
    if (pos.status === 'fulfilled') {
      const overdue = pos.value.filter((p) => ['01', '02', '03'].includes(p.status_code) && p.delivery_date < today).sort((a, b) => a.delivery_date.localeCompare(b.delivery_date));
      panels.push(h('div', { class: 'panel' },
        h('h2', null, 'Overdue and not shipped'),
        h('p', { class: 'note' }, 'Requested delivery date has passed and nothing has been shipped yet.'),
        h('div', { class: 'scroll' }, table([
          { label: 'PO', render: (p) => link('erp/purchase-orders', p.po_number, p.po_number, 'id') },
          { label: 'Status', render: (p) => badge(p.status_code, PO_STATUS[p.status_code]) },
          { label: 'Due', render: (p) => h('span', null, fmtDate(p.delivery_date), h('span', { class: 'sub' }, relative(p.delivery_date))) },
          { label: 'Vendor', render: (p) => h('span', { class: 'mono' }, p.vendor_id) },
        ], overdue, { empty: { title: 'Nothing overdue', text: 'Every open order is still within its requested date.' } }))));
    }
    if (pos.status === 'fulfilled' && suppliers.status === 'fulfilled') {
      const byVendor = new Map(suppliers.value.map((s) => [s.erpVendorNumber, s]));
      const risky = pos.value
        .filter((p) => ['01', '02', '03', '04'].includes(p.status_code))
        .map((p) => ({ po: p, s: byVendor.get(p.vendor_id) }))
        .filter((x) => !x.s || x.s.status !== 'ACTIVE');
      panels.push(h('div', { class: 'panel' },
        h('h2', null, 'Open orders with suppliers on hold or blocked'),
        h('p', { class: 'note' }, 'A join neither system can answer alone: ERP open orders against SRM supplier status.'),
        h('div', { class: 'scroll' }, table([
          { label: 'PO', render: (x) => link('erp/purchase-orders', x.po.po_number, x.po.po_number, 'id') },
          { label: 'PO status', render: (x) => badge(x.po.status_code, PO_STATUS[x.po.status_code]) },
          { label: 'Supplier', render: (x) => (x.s ? link('srm/suppliers', x.s.supplierCode, x.s.name.trading || x.s.name.legal) : h('em', null, `vendor ${x.po.vendor_id} unmapped`)) },
          { label: 'SRM status', render: (x) => (x.s ? badge(x.s.status, SUPPLIER_STATUS[x.s.status]) : '') },
        ], risky, { empty: { title: 'No conflicts', text: 'Every open order belongs to an active supplier.' } }))));
    }

    mount(main,
      h('div', { class: 'pipeline' },
        h('h2', null, 'Order to dock, across three systems'),
        h('p', { class: 'note' }, 'Each lane is read from a different backend with its own paging and data format. Select a count to open the filtered list.'),
        lanes),
      h('div', { class: 'grid-2' }, panels));
  },
};
