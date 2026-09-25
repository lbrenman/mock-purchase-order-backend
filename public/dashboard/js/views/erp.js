import { call, get, post, patch, del } from '../api.js';
import {
  h, table, kv, badge, jsonView, fmtDate, fmtDateTime, relative, num, money, isoDate, sapDate,
  openDrawer, closeDrawer, formModal, confirmModal, toast, compact, errorText,
} from '../ui.js';
import { listPage } from '../list.js';
import * as cache from '../cache.js';
import { link, xrefBox, rawTab, dialectNote } from './common.js';

export const STATUS = { '01': 'Open', '02': 'Partially confirmed', '03': 'Confirmed', '04': 'In delivery', '05': 'Closed', '09': 'Cancelled' };
const FACADE = { '01': 'OPEN', '02': 'PARTIALLY_ACKNOWLEDGED', '03': 'ACKNOWLEDGED', '04': 'IN_FULFILLMENT', '05': 'CLOSED', '09': 'CANCELLED' };
const CATS = { AB: 'Accepted as ordered', AC: 'Accepted with changes', RJ: 'Rejected' };
const LOCKED = ['05', '09'];

const statusBadge = (code) => badge(code, STATUS[code]);

// ═══ Purchase orders ═══════════════════════════════════════════════════
const poPage = {
  id: 'erp/purchase-orders',
  sys: 'erp',
  nav: 'Purchase orders',
  title: 'Purchase orders',
  render(main, ctx) {
    return listPage(main, {
      id: this.id,
      sys: 'erp',
      paging: 'page',
      presetFilters: ctx.query,
      lede: 'System of record for purchase orders. Supplier names come from SRM through the vendor cross-reference, the same join the iPaaS has to make.',
      dialect: 'ERP: page/limit, {data, pagination}',
      filters: [
        { name: 'status', label: 'Status', type: 'select', options: Object.entries(STATUS).map(([v, l]) => ({ value: v, label: `${v} ${l}` })) },
        { name: 'vendor_id', label: 'Supplier', type: 'select', options: () => cache.supplierOptions({ withVendor: true }) },
        { name: 'plant', label: 'Plant', type: 'select', options: async () => (await cache.plants()).map((p) => ({ value: p.plant_code, label: `${p.plant_code} ${p.city}` })) },
        { name: 'po_number', label: 'PO number', placeholder: '4500123456' },
      ],
      actions: [h('button', { type: 'button', class: 'btn primary', 'data-sys': 'erp', onclick: () => newPo(ctx) }, 'New purchase order')],
      load: async ({ filters, page, limit }) => {
        const r = await get('erp', '/v1/purchase-orders', { ...filters, page, limit });
        const map = await cache.vendorsToSuppliers(r.data.map((p) => p.vendor_id));
        return { rows: r.data.map((p) => ({ ...p, _supplier: map[p.vendor_id] })), total: r.pagination.total, hasNext: r.pagination.hasNext };
      },
      rowKey: (r) => r.po_number,
      onOpen: (r) => ctx.go(this.id, r.po_number),
      columns: [
        { label: 'PO', render: (r) => h('span', null, h('span', { class: 'id' }, r.po_number), h('span', { class: 'sub' }, `revision ${r.revision}`)) },
        { label: 'Supplier', render: (r) => h('span', null, r._supplier ? r._supplier.legalName : h('em', { class: 'muted' }, 'not in SRM'), h('span', { class: 'sub mono' }, `vendor ${r.vendor_id}`)) },
        { label: 'Status', render: (r) => statusBadge(r.status_code) },
        { label: 'Plant', render: (r) => h('span', { class: 'mono' }, `${r.plant} / ${r.purch_org}`) },
        { label: 'Delivery date', render: (r) => h('span', null, fmtDate(r.delivery_date), h('span', { class: 'sub' }, relative(r.delivery_date))) },
        { label: 'Items', num: true, render: (r) => r.item_count },
        { label: 'Changed', render: (r) => fmtDateTime(r.changed_at) },
      ],
    });
  },
  open: (id, ctx) => openPo(id, ctx),
};

async function openPo(poNumber, ctx) {
  let res;
  try {
    res = await call('erp', 'GET', `/v1/purchase-orders/${encodeURIComponent(poNumber)}`);
  } catch (err) {
    toast(errorText(err), 'error');
    return ctx.go(poPage.id);
  }
  const po = res.data.data;
  const etag = res.headers.get('etag');
  const locked = LOCKED.includes(po.status_code);
  const refresh = () => { cache.invalidate('pos'); ctx.reload(); openPo(poNumber, ctx); };

  const actions = [
    h('button', { type: 'button', class: 'btn small primary', 'data-sys': 'erp', disabled: locked, onclick: () => confirmPo(po, etag, refresh) }, 'Record supplier confirmation'),
    h('button', { type: 'button', class: 'btn small', disabled: locked, onclick: () => postDelivery(po, refresh) }, 'Post inbound delivery'),
    h('button', { type: 'button', class: 'btn small', disabled: locked, onclick: () => editPo(po, refresh) }, 'Edit header'),
    h('button', { type: 'button', class: 'btn small', disabled: locked, onclick: () => addItem(po, refresh) }, 'Add item'),
    h('button', { type: 'button', class: 'btn small', disabled: locked, onclick: () => setStatus(po, '05', refresh) }, 'Close PO'),
    h('button', { type: 'button', class: 'btn small danger', disabled: locked, onclick: () => setStatus(po, '09', refresh) }, 'Cancel PO'),
    h('button', { type: 'button', class: 'btn small danger', onclick: () => deletePo(po, ctx) }, 'Delete'),
  ];

  openDrawer({
    sys: 'erp',
    kicker: `Purchase order, revision ${po.revision}`,
    title: h('span', { class: 'mono' }, po.po_number),
    subtitle: h('span', null, statusBadge(po.status_code), ' ', h('span', { class: 'muted' }, `façade status ${FACADE[po.status_code]}, ETag ${etag || 'n/a'}`)),
    actions,
    onClose: () => ctx.go(poPage.id),
    tabs: [
      { label: 'Details', render: () => poDetails(po, refresh) },
      { label: 'Confirmations & deliveries', render: () => poDocuments(po) },
      { label: 'Across systems', render: () => poAcross(po) },
      rawTab('erp', res.data, 'GET /erp/v1/purchase-orders/' + po.po_number),
    ],
  });
}

async function poDetails(po, refresh) {
  // The ERP embeds ship_to and purch_org_name in every purchase order, so no plant or org lookups are needed.
  const sup = await cache.vendorsToSuppliers([po.vendor_id]);
  const plant = po.ship_to;
  const s = sup[po.vendor_id];
  const locked = LOCKED.includes(po.status_code);
  const total = po.items.reduce((a, i) => a + Number(i.quantity) * Number(i.net_price), 0);
  return h('div', null,
    h('section', { class: 'cols-2' },
      kv([
        ['Vendor', h('span', null, h('span', { class: 'mono' }, po.vendor_id), s ? h('span', null, ' ', link('srm/suppliers', s.supplierCode, s.legalName)) : h('em', { class: 'muted' }, ' unmapped'))],
        ['Purchasing org', `${po.purch_org}${po.purch_org_name ? ` (${po.purch_org_name})` : ''}`],
        ['Plant', h('span', null, h('span', { class: 'mono' }, po.plant), plant ? ` ${plant.name}, ${plant.site_code}` : '')],
        ['Ship-to address', plant ? [plant.street, plant.city, [plant.region, plant.postal_code].filter(Boolean).join(' '), plant.country].filter(Boolean).join(', ') : '—'],
        ['Buyer', po.buyer_name],
      ]),
      kv([
        ['Document date', fmtDate(po.doc_date)],
        ['Delivery date', `${fmtDate(po.delivery_date)} (${relative(po.delivery_date)})`],
        ['Incoterms / terms', `${po.incoterms || '—'} / ${po.payment_terms || '—'}`],
        ['Order value', money(total, po.currency)],
      ])),
    h('section', null,
      h('h3', null, 'Items'),
      h('div', { class: 'table-wrap standalone' }, table([
        { label: 'Item', render: (i) => h('span', { class: 'id' }, i.item_no) },
        { label: 'Material', render: (i) => h('span', null, i.short_text, h('span', { class: 'sub mono' }, i.material)) },
        { label: 'Ordered', num: true, render: (i) => `${num(i.quantity)} ${i.uom}` },
        { label: 'Confirmed', num: true, render: (i) => h('span', null, num(i.confirmed_qty), i.confirmed_date ? h('span', { class: 'sub' }, fmtDate(i.confirmed_date)) : null, i.reject_reason ? h('span', { class: 'sub' }, i.reject_reason) : null) },
        { label: 'Shipped', num: true, render: (i) => num(i.shipped_qty) },
        { label: 'Open', num: true, render: (i) => h('strong', null, num(i.open_qty)) },
        { label: 'Price', num: true, render: (i) => money(i.net_price, po.currency) },
        { label: '', render: (i) => locked ? '' : h('div', { class: 'inline-actions' },
          h('button', { type: 'button', class: 'btn small', onclick: () => editItem(po, i, refresh) }, 'Edit'),
          h('button', { type: 'button', class: 'btn small danger', onclick: () => deleteItem(po, i, refresh) }, 'Delete')) },
      ], po.items))),
    h('section', null, h('div', { class: 'callout', style: { '--sys-color': 'var(--erp)' } },
      'Quantities are strings with three decimals and dates are YYYYMMDD on the wire. Header changes and item edits bump the revision, which re-opens supplier confirmation.')));
}

async function poDocuments(po) {
  const [conf, dels] = await Promise.all([
    get('erp', `/v1/purchase-orders/${po.po_number}/confirmations`),
    get('erp', '/v1/inbound-deliveries', { po_number: po.po_number, limit: 50 }),
  ]);
  return h('div', null,
    h('section', null, h('h3', null, 'Supplier confirmations'),
      h('div', { class: 'table-wrap standalone' }, table([
        { label: 'Confirmation', render: (c) => link('erp/confirmations', c.confirmation_no, c.confirmation_no, 'id') },
        { label: 'Revision', num: true, render: (c) => c.po_revision },
        { label: 'Category', render: (c) => badge(c.conf_category, CATS[c.conf_category]) },
        { label: 'Status', render: (c) => badge(c.status) },
        { label: 'Vendor ref', render: (c) => c.vendor_reference },
        { label: 'Posted', render: (c) => fmtDateTime(c.posted_at) },
      ], conf.data, { empty: { title: 'No confirmations yet', text: 'Use "Record supplier confirmation" to post one for this revision.' } }))),
    h('section', null, h('h3', null, 'Inbound deliveries'),
      h('div', { class: 'table-wrap standalone' }, table([
        { label: 'Delivery', render: (d) => link('erp/inbound-deliveries', d.delivery_no, d.delivery_no, 'id') },
        { label: 'ASN', render: (d) => h('span', { class: 'mono' }, d.asn_reference) },
        { label: 'Status', render: (d) => badge(d.status) },
        { label: 'Qty for this PO', num: true, render: (d) => num(d.items.filter((i) => i.po_number === po.po_number).reduce((a, i) => a + Number(i.quantity), 0)) },
        { label: 'Posted', render: (d) => fmtDateTime(d.posted_at) },
      ], dels.data, { empty: { title: 'Nothing shipped yet', text: 'Deliveries are posted when a supplier ASN reaches the ERP.' } }))));
}

async function poAcross(po) {
  const boxes = [];
  const sup = (await cache.vendorsToSuppliers([po.vendor_id]))[po.vendor_id];
  if (sup) {
    const s = await get('srm', `/v1/suppliers/${sup.supplierCode}`, { expand: '' }).catch(() => null);
    boxes.push(xrefBox('srm', 'Supplier master', `GET /srm/v1/vendor-xref?erpVendorNumber=${po.vendor_id}`, s ? kv([
      ['Supplier', link('srm/suppliers', s.supplierCode, `${s.name.legal} (${s.supplierCode})`)],
      ['Status', h('span', null, badge(s.status), s.statusReason ? ` ${s.statusReason}` : '')],
      ['Classification', `${s.classification.tier}, ${s.classification.riskRating} risk`],
      ['Can send ASNs', s.capabilities.asn ? 'Yes' : 'No'],
    ]) : h('p', { class: 'muted' }, 'Supplier record could not be loaded.')));
  } else {
    boxes.push(xrefBox('srm', 'Supplier master', `GET /srm/v1/vendor-xref?erpVendorNumber=${po.vendor_id}`,
      h('p', null, `ERP vendor ${po.vendor_id} has no supplier master record. The façade would return 404 VENDOR_NOT_MAPPED here.`)));
  }
  const shipments = await get('tms', '/v1/shipments', { poNumber: po.po_number, limit: 50 }).then((r) => r.results).catch(() => null);
  boxes.push(xrefBox('tms', 'Shipments carrying this PO', `GET /tms/v1/shipments?poNumber=${po.po_number}`, shipments ? h('div', { class: 'table-wrap standalone' }, table([
    { label: 'Shipment', render: (s) => link('tms/shipments', s.shipmentId, s.shipmentId, 'id') },
    { label: 'ASN', render: (s) => h('span', { class: 'mono' }, s.asnNumber) },
    { label: 'Milestone', render: (s) => badge(s.milestone.code, s.milestone.description.split(' - ')[0]) },
    { label: 'Qty', num: true, render: (s) => num(s.contents.filter((c) => c.poNumber === po.po_number).reduce((a, c) => a + c.quantity.value, 0)) },
    { label: 'ETA', render: (s) => fmtDateTime(s.schedule.estimatedArrival) },
  ], shipments, { empty: { title: 'No shipments', text: 'TMS has no ASN referencing this PO.' } })) : h('p', { class: 'muted' }, 'TMS is unavailable.')));
  return h('div', null, dialectNote('One purchase order, three systems. This is the aggregation the Supplier Order Collaboration façade performs for GET /purchase-orders/{id}.'), boxes);
}

// ── PO forms ───────────────────────────────────────────────────────────
async function newPo(ctx) {
  const created = await formModal({
    sys: 'erp',
    title: 'New purchase order',
    intro: 'Creates the PO in ERP only. The vendor must exist in SRM for the façade to resolve it.',
    fields: [
      { name: 'vendor_id', label: 'Supplier (ERP vendor)', type: 'select', required: true, options: () => cache.supplierOptions({ withVendor: true }) },
      { name: 'purch_org', label: 'Purchasing org', type: 'select', required: true, options: async () => (await cache.purchOrgs()).map((o) => ({ value: o.code, label: `${o.code} ${o.name}` })) },
      { name: 'plant', label: 'Plant', type: 'select', required: true, options: async () => (await cache.plants()).map((p) => ({ value: p.plant_code, label: `${p.plant_code} ${p.name}` })) },
      { name: 'currency', label: 'Currency', value: 'USD', required: true, max: 3 },
      { name: 'delivery_date', label: 'Requested delivery', type: 'date', required: true },
      { name: 'buyer_name', label: 'Buyer' },
      { name: 'incoterms', label: 'Incoterms', value: 'FCA' },
      { name: 'payment_terms', label: 'Payment terms', value: 'NET60' },
      {
        name: 'items', label: 'Items', type: 'lines', value: [{ uom: 'EA' }], addLabel: 'Add item',
        columns: [
          { name: 'material', label: 'Material', required: true },
          { name: 'short_text', label: 'Description', required: true },
          { name: 'quantity', label: 'Quantity', type: 'number', min: 0 },
          { name: 'uom', label: 'UoM' },
          { name: 'net_price', label: 'Net price', type: 'number', min: 0, step: '0.01' },
        ],
      },
    ],
    submitLabel: 'Create purchase order',
    onSubmit: async (v) => {
      const body = compact({ ...v, delivery_date: sapDate(v.delivery_date), currency: (v.currency || '').toUpperCase(), items: v.items.filter((i) => i.material || i.short_text) });
      return (await post('erp', '/v1/purchase-orders', body)).data;
    },
  });
  if (created) {
    toast(`Created purchase order ${created.po_number}`);
    cache.invalidate('pos');
    ctx.go(poPage.id, created.po_number, { reload: true });
  }
}

async function editPo(po, refresh) {
  const ok = await formModal({
    sys: 'erp',
    title: `Edit purchase order ${po.po_number}`,
    intro: 'Saving creates revision ' + (po.revision + 1) + '. The supplier can then confirm again.',
    fields: [
      { name: 'delivery_date', label: 'Requested delivery', type: 'date', value: po.delivery_date },
      { name: 'buyer_name', label: 'Buyer', value: po.buyer_name },
      { name: 'incoterms', label: 'Incoterms', value: po.incoterms },
      { name: 'payment_terms', label: 'Payment terms', value: po.payment_terms },
    ],
    submitLabel: 'Save changes',
    onSubmit: (v) => patch('erp', `/v1/purchase-orders/${po.po_number}`, compact({
      delivery_date: sapDate(v.delivery_date) !== po.delivery_date ? sapDate(v.delivery_date) : undefined,
      buyer_name: v.buyer_name !== po.buyer_name ? v.buyer_name : undefined,
      incoterms: v.incoterms !== po.incoterms ? v.incoterms : undefined,
      payment_terms: v.payment_terms !== po.payment_terms ? v.payment_terms : undefined,
    })),
  });
  if (ok) { toast('Purchase order saved'); refresh(); }
}

async function addItem(po, refresh) {
  const ok = await formModal({
    sys: 'erp', title: `Add item to ${po.po_number}`, intro: 'Item numbers continue in steps of 10.',
    fields: [
      { name: 'material', label: 'Material', required: true },
      { name: 'short_text', label: 'Description', required: true },
      { name: 'quantity', label: 'Quantity', type: 'number', required: true, min: 0 },
      { name: 'uom', label: 'Unit of measure', value: 'EA', required: true },
      { name: 'net_price', label: 'Net price', type: 'number', min: 0, step: '0.01' },
    ],
    submitLabel: 'Add item',
    onSubmit: (v) => post('erp', `/v1/purchase-orders/${po.po_number}/items`, compact(v)),
  });
  if (ok) { toast('Item added'); refresh(); }
}

async function editItem(po, item, refresh) {
  const ok = await formModal({
    sys: 'erp', title: `Edit item ${item.item_no}`, intro: `Shipped so far: ${num(item.shipped_qty)} ${item.uom}. Quantity cannot go below that.`,
    fields: [
      { name: 'short_text', label: 'Description', value: item.short_text, wide: true },
      { name: 'quantity', label: 'Quantity', type: 'number', value: Number(item.quantity), min: 0 },
      { name: 'net_price', label: 'Net price', type: 'number', value: Number(item.net_price), step: '0.01', min: 0 },
    ],
    submitLabel: 'Save item',
    onSubmit: (v) => patch('erp', `/v1/purchase-orders/${po.po_number}/items/${item.item_no}`, compact({
      short_text: v.short_text !== item.short_text ? v.short_text : undefined,
      quantity: v.quantity !== Number(item.quantity) ? v.quantity : undefined,
      net_price: v.net_price !== Number(item.net_price) ? v.net_price : undefined,
    })),
  });
  if (ok) { toast('Item saved'); refresh(); }
}

async function deleteItem(po, item, refresh) {
  const ok = await confirmModal({
    sys: 'erp', title: `Delete item ${item.item_no}?`, confirmLabel: 'Delete item',
    text: 'Only items with nothing confirmed or shipped can be deleted.',
    onConfirm: () => del('erp', `/v1/purchase-orders/${po.po_number}/items/${item.item_no}`),
  });
  if (ok) { toast('Item deleted'); refresh(); }
}

async function setStatus(po, code, refresh) {
  const verb = code === '09' ? 'Cancel' : 'Close';
  const ok = await confirmModal({
    sys: 'erp', title: `${verb} purchase order ${po.po_number}?`, confirmLabel: `${verb} purchase order`,
    text: code === '09' ? 'Cancelled POs are locked: no confirmations, deliveries or edits.' : 'Closed POs are locked: no further confirmations or deliveries.',
    onConfirm: () => patch('erp', `/v1/purchase-orders/${po.po_number}`, { status_code: code }),
  });
  if (ok) { toast(`Purchase order ${code === '09' ? 'cancelled' : 'closed'}`); refresh(); }
}

async function deletePo(po, ctx) {
  const ok = await confirmModal({
    sys: 'erp', title: `Delete purchase order ${po.po_number}?`, confirmLabel: 'Delete purchase order',
    text: 'ERP refuses to delete a PO that already has confirmations or deliveries (409 PO_HAS_FOLLOW_ON_DOCUMENTS). Cancel it instead.',
    onConfirm: () => del('erp', `/v1/purchase-orders/${po.po_number}`),
  });
  if (ok) {
    toast(`Deleted purchase order ${po.po_number}`);
    cache.invalidate('pos');
    closeDrawer({ silent: true });
    ctx.go(poPage.id, null, { reload: true });
  }
}

async function confirmPo(po, etag, refresh) {
  const ok = await formModal({
    sys: 'erp',
    title: `Record supplier confirmation for ${po.po_number}`,
    intro: `One confirmation per revision (currently ${po.revision}). AB needs full quantities and the requested date; AC with less quantity or a later date goes to IN_REVIEW; RJ needs zero quantities.`,
    fields: [
      { name: 'conf_category', label: 'Category', type: 'select', required: true, options: Object.entries(CATS).map(([v, l]) => ({ value: v, label: `${v} ${l}` })) },
      { name: 'vendor_reference', label: 'Supplier reference', value: `SUP-ACK-${Math.floor(Math.random() * 90000 + 10000)}` },
      { name: 'note', label: 'Note', type: 'textarea' },
      { name: 'useEtag', label: `Send If-Match ${etag || ''} (optimistic concurrency)`, type: 'checkbox', value: true, wide: true },
      {
        name: 'items', label: 'Lines', type: 'lines', fixed: true,
        value: po.items.map((i) => ({ item_no: i.item_no, confirmed_qty: Number(i.quantity), confirmed_date: po.delivery_date })),
        columns: [
          { name: 'item_no', label: 'Item', readonly: true },
          { name: 'confirmed_qty', label: 'Confirmed qty', type: 'number', min: 0 },
          { name: 'confirmed_date', label: 'Confirmed date', type: 'date' },
          { name: 'reject_reason', label: 'Reject reason' },
        ],
      },
    ],
    submitLabel: 'Post confirmation',
    onSubmit: async (v) => {
      const body = compact({
        conf_category: v.conf_category, vendor_reference: v.vendor_reference, note: v.note,
        items: v.items.map((i) => ({ item_no: i.item_no, confirmed_qty: i.confirmed_qty ?? 0, confirmed_date: v.conf_category === 'RJ' ? undefined : sapDate(i.confirmed_date), reject_reason: i.reject_reason })),
      });
      const headers = v.useEtag && etag ? { 'If-Match': etag } : {};
      return (await call('erp', 'POST', `/v1/purchase-orders/${po.po_number}/confirmations`, { body, headers })).data.data;
    },
  });
  if (ok) { toast(`Confirmation ${ok.confirmation_no} posted (${ok.status})`); refresh(); }
}

async function postDelivery(po, refresh) {
  const open = po.items.filter((i) => Number(i.open_qty) > 0);
  if (!open.length) return toast('Every item is fully shipped.', 'error');
  const ok = await formModal({
    sys: 'erp',
    title: `Post inbound delivery for ${po.po_number}`,
    intro: 'This is the ERP half of an ASN: it reserves open quantity. Over-shipping returns 422 SHIPPED_QUANTITY_EXCEEDS_OPEN_QUANTITY. Create the TMS shipment separately, or use the façade to orchestrate both.',
    fields: [
      { name: 'asn_reference', label: 'ASN reference', required: true, value: `ASN-${Date.now().toString().slice(-6)}` },
      {
        name: 'items', label: 'Quantities', type: 'lines', fixed: true,
        value: open.map((i) => ({ item_no: i.item_no, open: `${num(i.open_qty)} ${i.uom}`, quantity: Number(i.open_qty) })),
        columns: [
          { name: 'item_no', label: 'Item', readonly: true },
          { name: 'open', label: 'Open', readonly: true },
          { name: 'quantity', label: 'Ship now', type: 'number', min: 0 },
        ],
      },
    ],
    submitLabel: 'Post delivery',
    onSubmit: async (v) => (await post('erp', '/v1/inbound-deliveries', {
      asn_reference: v.asn_reference, vendor_id: po.vendor_id,
      items: v.items.filter((i) => i.quantity > 0).map((i) => ({ po_number: po.po_number, item_no: i.item_no, quantity: i.quantity })),
    })).data,
  });
  if (ok) { toast(`Inbound delivery ${ok.delivery_no} posted`); refresh(); }
}

// ═══ Confirmations ══════════════════════════════════════════════════════
const confPage = {
  id: 'erp/confirmations',
  sys: 'erp',
  nav: 'Confirmations',
  title: 'Supplier confirmations',
  render(main, ctx) {
    return listPage(main, {
      id: this.id, sys: 'erp', paging: 'page', presetFilters: ctx.query,
      lede: 'Order acknowledgements as ERP stores them. The façade maps AB, AC and RJ to ACCEPT, ACCEPT_WITH_CHANGES and REJECT, and POSTED or IN_REVIEW to RECORDED or PENDING_REVIEW.',
      dialect: 'ERP: page/limit, {data, pagination}',
      filters: [
        { name: 'status', label: 'Status', type: 'select', options: ['POSTED', 'IN_REVIEW'] },
        { name: 'conf_category', label: 'Category', type: 'select', options: Object.entries(CATS).map(([v, l]) => ({ value: v, label: `${v} ${l}` })) },
        { name: 'po_number', label: 'PO number', placeholder: '4500123461' },
      ],
      load: async ({ filters, page, limit }) => {
        const r = await get('erp', '/v1/confirmations', { ...filters, page, limit });
        return { rows: r.data, total: r.pagination.total, hasNext: r.pagination.hasNext };
      },
      rowKey: (r) => r.confirmation_no,
      onOpen: (r) => ctx.go(this.id, r.confirmation_no),
      columns: [
        { label: 'Confirmation', render: (c) => h('span', { class: 'id' }, c.confirmation_no) },
        { label: 'PO', render: (c) => link('erp/purchase-orders', c.po_number, `${c.po_number} r${c.po_revision}`, 'id') },
        { label: 'Category', render: (c) => badge(c.conf_category, CATS[c.conf_category]) },
        { label: 'Status', render: (c) => badge(c.status) },
        { label: 'Vendor', render: (c) => h('span', { class: 'mono' }, c.vendor_id) },
        { label: 'Supplier ref', render: (c) => c.vendor_reference },
        { label: 'Posted', render: (c) => fmtDateTime(c.posted_at) },
      ],
    });
  },
  async open(id, ctx) {
    let data;
    try {
      data = await get('erp', `/v1/confirmations/${encodeURIComponent(id)}`);
    } catch (err) {
      toast(errorText(err), 'error');
      return ctx.go(this.id);
    }
    const c = data.data;
    openDrawer({
      sys: 'erp', kicker: 'Supplier confirmation', title: h('span', { class: 'mono' }, c.confirmation_no),
      subtitle: h('span', null, badge(c.conf_category, CATS[c.conf_category]), ' ', badge(c.status)),
      onClose: () => ctx.go(this.id),
      tabs: [
        {
          label: 'Details',
          render: () => h('div', null,
            kv([
              ['Purchase order', link('erp/purchase-orders', c.po_number, c.po_number, 'mono')],
              ['PO revision', c.po_revision],
              ['Supplier reference', c.vendor_reference],
              ['Note', c.note],
              ['Posted', fmtDateTime(c.posted_at)],
            ]),
            h('section', null, h('h3', null, 'Lines'), h('div', { class: 'table-wrap standalone' }, table([
              { label: 'Item', render: (i) => h('span', { class: 'id' }, i.item_no) },
              { label: 'Confirmed qty', num: true, render: (i) => num(i.confirmed_qty) },
              { label: 'Confirmed date', render: (i) => fmtDate(i.confirmed_date) },
              { label: 'Reject reason', render: (i) => i.reject_reason },
            ], c.items))),
            h('section', null, h('p', { class: 'muted' }, 'Confirmations are immutable. After a buyer change (new revision) the supplier posts a new one.'))),
        },
        rawTab('erp', data, `GET /erp/v1/confirmations/${c.confirmation_no}`),
      ],
    });
  },
};

// ═══ Inbound deliveries ═════════════════════════════════════════════════
const delPage = {
  id: 'erp/inbound-deliveries',
  sys: 'erp',
  nav: 'Inbound deliveries',
  title: 'Inbound deliveries',
  render(main, ctx) {
    return listPage(main, {
      id: this.id, sys: 'erp', paging: 'page', presetFilters: ctx.query,
      lede: 'The ERP side of each advance shipment notice. Posting one reserves open PO quantity; reversing it is the compensation step of the ASN saga.',
      dialect: 'ERP: page/limit, {data, pagination}',
      filters: [
        { name: 'status', label: 'Status', type: 'select', options: ['POSTED', 'REVERSED'] },
        { name: 'asn_reference', label: 'ASN reference', placeholder: 'ASN-439901' },
        { name: 'po_number', label: 'PO number', placeholder: '4500123458' },
      ],
      actions: [h('button', { type: 'button', class: 'btn primary', 'data-sys': 'erp', onclick: () => newDelivery(ctx) }, 'New inbound delivery')],
      load: async ({ filters, page, limit }) => {
        const r = await get('erp', '/v1/inbound-deliveries', { ...filters, page, limit });
        return { rows: r.data, total: r.pagination.total, hasNext: r.pagination.hasNext };
      },
      rowKey: (r) => r.delivery_no,
      onOpen: (r) => ctx.go(this.id, r.delivery_no),
      columns: [
        { label: 'Delivery', render: (d) => h('span', { class: 'id' }, d.delivery_no) },
        { label: 'ASN reference', render: (d) => h('span', { class: 'mono' }, d.asn_reference) },
        { label: 'Vendor', render: (d) => h('span', { class: 'mono' }, d.vendor_id) },
        { label: 'Status', render: (d) => badge(d.status) },
        { label: 'Purchase orders', render: (d) => [...new Set(d.items.map((i) => i.po_number))].join(', ') },
        { label: 'Quantity', num: true, render: (d) => num(d.items.reduce((a, i) => a + Number(i.quantity), 0)) },
        { label: 'Posted', render: (d) => fmtDateTime(d.posted_at) },
      ],
    });
  },
  async open(id, ctx) {
    let data;
    try {
      data = await get('erp', `/v1/inbound-deliveries/${encodeURIComponent(id)}`);
    } catch (err) {
      toast(errorText(err), 'error');
      return ctx.go(this.id);
    }
    const d = data.data;
    const reverse = async () => {
      const ok = await confirmModal({
        sys: 'erp', title: `Reverse inbound delivery ${d.delivery_no}?`, confirmLabel: 'Reverse delivery',
        text: 'Releases the reserved quantity back to the PO items. This is the ERP compensation an orchestration runs when the TMS step fails.',
        onConfirm: () => post('erp', `/v1/inbound-deliveries/${d.delivery_no}/reverse`, { reason: 'Reversed from dashboard' }),
      });
      if (ok) { toast('Delivery reversed'); cache.invalidate('pos'); ctx.reload(); this.open(id, ctx); }
    };
    openDrawer({
      sys: 'erp', kicker: 'Inbound delivery', title: h('span', { class: 'mono' }, d.delivery_no),
      subtitle: h('span', null, badge(d.status), ' ', h('span', { class: 'muted' }, `ASN ${d.asn_reference}`)),
      actions: [h('button', { type: 'button', class: 'btn small danger', disabled: d.status !== 'POSTED', onclick: reverse }, 'Reverse delivery')],
      onClose: () => ctx.go(this.id),
      tabs: [
        {
          label: 'Details',
          render: () => h('div', null,
            kv([
              ['Vendor', h('span', { class: 'mono' }, d.vendor_id)],
              ['ASN reference', h('span', { class: 'mono' }, d.asn_reference)],
              ['Posted', fmtDateTime(d.posted_at)],
              ['Reversed', d.reversed_at ? fmtDateTime(d.reversed_at) : null],
            ]),
            h('section', null, h('h3', null, 'Items'), h('div', { class: 'table-wrap standalone' }, table([
              { label: 'PO', render: (i) => link('erp/purchase-orders', i.po_number, i.po_number, 'id') },
              { label: 'Item', render: (i) => h('span', { class: 'mono' }, i.item_no) },
              { label: 'Quantity', num: true, render: (i) => num(i.quantity) },
            ], d.items)))),
        },
        {
          label: 'Across systems',
          render: async () => {
            const [shp, sup] = await Promise.all([
              get('tms', '/v1/shipments', { asnNumber: d.asn_reference }).then((r) => r.results).catch(() => null),
              cache.vendorsToSuppliers([d.vendor_id]),
            ]);
            const s = sup[d.vendor_id];
            return h('div', null,
              dialectNote('ERP keys the delivery by vendor number and ASN reference; TMS keys the shipment by supplier code and ASN number.'),
              xrefBox('srm', 'Supplier', `GET /srm/v1/vendor-xref?erpVendorNumber=${d.vendor_id}`,
                s ? kv([['Supplier', link('srm/suppliers', s.supplierCode, `${s.legalName} (${s.supplierCode})`)], ['Status', badge(s.status)]]) : h('p', null, 'Vendor not mapped in SRM.')),
              xrefBox('tms', 'Shipment with the same ASN', `GET /tms/v1/shipments?asnNumber=${d.asn_reference}`,
                shp && shp.length ? h('div', { class: 'table-wrap standalone' }, table([
                  { label: 'Shipment', render: (x) => link('tms/shipments', x.shipmentId, x.shipmentId, 'id') },
                  { label: 'Carrier', render: (x) => `${x.carrier.name} (${x.carrier.scac})` },
                  { label: 'Milestone', render: (x) => badge(x.milestone.code, x.milestone.description.split(' - ')[0]) },
                  { label: 'ETA', render: (x) => fmtDateTime(x.schedule.estimatedArrival) },
                ], shp)) : h('p', null, shp ? 'No TMS shipment uses this ASN number.' : 'TMS is unavailable.')));
          },
        },
        rawTab('erp', data, `GET /erp/v1/inbound-deliveries/${d.delivery_no}`),
      ],
    });
  },
};

async function newDelivery(ctx) {
  const ok = await formModal({
    sys: 'erp', title: 'New inbound delivery',
    intro: 'Items must belong to the chosen vendor and have enough open quantity.',
    fields: [
      { name: 'vendor_id', label: 'Supplier (ERP vendor)', type: 'select', required: true, options: () => cache.supplierOptions({ withVendor: true }) },
      { name: 'asn_reference', label: 'ASN reference', required: true, value: `ASN-${Date.now().toString().slice(-6)}` },
      {
        name: 'items', label: 'Items', type: 'lines', value: [{ item_no: '00010' }],
        columns: [
          { name: 'po_number', label: 'PO number' },
          { name: 'item_no', label: 'Item (00010)' },
          { name: 'quantity', label: 'Quantity', type: 'number', min: 0 },
        ],
      },
    ],
    submitLabel: 'Post delivery',
    onSubmit: async (v) => (await post('erp', '/v1/inbound-deliveries', { ...v, items: v.items.filter((i) => i.po_number) })).data,
  });
  if (ok) { toast(`Inbound delivery ${ok.delivery_no} posted`); cache.invalidate('pos'); ctx.go(delPage.id, ok.delivery_no, { reload: true }); }
}

// ═══ Plants ═════════════════════════════════════════════════════════════
const plantFields = (p = {}, isNew) => [
  isNew ? { name: 'plant_code', label: 'Plant code (4 digits)', required: true } : null,
  { name: 'site_code', label: 'Enterprise site code', required: isNew, value: p.site_code, help: 'Used as the façade shipTo.siteCode' },
  { name: 'name', label: 'Name', required: isNew, value: p.name, wide: true },
  { name: 'street', label: 'Street', value: p.street },
  { name: 'city', label: 'City', value: p.city },
  { name: 'region', label: 'Region', value: p.region },
  { name: 'postal_code', label: 'Postal code', value: p.postal_code },
  { name: 'country', label: 'Country (ISO-2)', required: isNew, value: p.country },
].filter(Boolean);

const plantPage = {
  id: 'erp/plants',
  sys: 'erp',
  nav: 'Plants',
  title: 'Plants',
  render(main, ctx) {
    return listPage(main, {
      id: this.id, sys: 'erp', paging: 'none',
      lede: 'ERP plant codes. The façade exposes ship-to addresses by site code, so every PO needs this lookup.',
      dialect: 'ERP: {data}',
      actions: [h('button', { type: 'button', class: 'btn primary', 'data-sys': 'erp', onclick: () => this.create(ctx) }, 'New plant')],
      load: async () => ({ rows: (await get('erp', '/v1/plants')).data }),
      rowKey: (r) => r.plant_code,
      onOpen: (r) => ctx.go(this.id, r.plant_code),
      columns: [
        { label: 'Plant', render: (p) => h('span', { class: 'id' }, p.plant_code) },
        { label: 'Site code', render: (p) => h('span', { class: 'mono' }, p.site_code) },
        { label: 'Name', key: 'name' },
        { label: 'City', render: (p) => [p.city, p.region].filter(Boolean).join(', ') },
        { label: 'Country', key: 'country' },
      ],
    });
  },
  async create(ctx) {
    const ok = await formModal({
      sys: 'erp', title: 'New plant', fields: plantFields({}, true), submitLabel: 'Create plant',
      onSubmit: async (v) => (await post('erp', '/v1/plants', compact({ ...v, country: v.country && v.country.toUpperCase() }))).data,
    });
    if (ok) { toast(`Plant ${ok.plant_code} created`); cache.invalidate('plants'); ctx.go(this.id, ok.plant_code, { reload: true }); }
  },
  async open(id, ctx) {
    let data;
    try {
      data = await get('erp', `/v1/plants/${encodeURIComponent(id)}`);
    } catch (err) {
      toast(errorText(err), 'error');
      return ctx.go(this.id);
    }
    const p = data.data;
    const edit = async () => {
      const ok = await formModal({
        sys: 'erp', title: `Edit plant ${p.plant_code}`, fields: plantFields(p, false), submitLabel: 'Save plant',
        onSubmit: (v) => patch('erp', `/v1/plants/${p.plant_code}`, compact(Object.fromEntries(Object.entries(v).filter(([k, x]) => x !== p[k])))),
      });
      if (ok) { toast('Plant saved'); cache.invalidate('plants'); ctx.reload(); this.open(id, ctx); }
    };
    const remove = async () => {
      const ok = await confirmModal({
        sys: 'erp', title: `Delete plant ${p.plant_code}?`, confirmLabel: 'Delete plant', text: 'Plants referenced by purchase orders cannot be deleted (409 PLANT_IN_USE).',
        onConfirm: () => del('erp', `/v1/plants/${p.plant_code}`),
      });
      if (ok) { toast('Plant deleted'); cache.invalidate('plants'); closeDrawer({ silent: true }); ctx.go(this.id, null, { reload: true }); }
    };
    openDrawer({
      sys: 'erp', kicker: 'Plant', title: `${p.plant_code} ${p.name}`, subtitle: h('span', { class: 'mono' }, p.site_code),
      actions: [h('button', { type: 'button', class: 'btn small', onclick: edit }, 'Edit'), h('button', { type: 'button', class: 'btn small danger', onclick: remove }, 'Delete')],
      onClose: () => ctx.go(this.id),
      tabs: [
        {
          label: 'Details',
          render: async () => {
            const pos = await get('erp', '/v1/purchase-orders', { plant: p.plant_code, limit: 50 });
            return h('div', null,
              kv([['Site code', h('span', { class: 'mono' }, p.site_code)], ['Address', [p.street, p.city, p.region, p.postal_code, p.country].filter(Boolean).join(', ')]]),
              h('section', null, h('h3', null, `Purchase orders delivering here (${pos.pagination.total})`), h('div', { class: 'table-wrap standalone' }, table([
                { label: 'PO', render: (x) => link('erp/purchase-orders', x.po_number, x.po_number, 'id') },
                { label: 'Vendor', render: (x) => h('span', { class: 'mono' }, x.vendor_id) },
                { label: 'Status', render: (x) => statusBadge(x.status_code) },
                { label: 'Delivery', render: (x) => fmtDate(x.delivery_date) },
              ], pos.data, { empty: { title: 'No purchase orders', text: 'This plant can be deleted.' } }))));
          },
        },
        rawTab('erp', data, `GET /erp/v1/plants/${p.plant_code}`),
      ],
    });
  },
};

// ═══ Purchasing organisations ═══════════════════════════════════════════
const orgPage = {
  id: 'erp/purchasing-orgs',
  sys: 'erp',
  nav: 'Purchasing orgs',
  title: 'Purchasing organisations',
  render(main, ctx) {
    return listPage(main, {
      id: this.id, sys: 'erp', paging: 'none',
      lede: 'ERP purchasing org codes (AMUS) that the façade translates to buying organisations (Acme-US).',
      dialect: 'ERP: {data}',
      actions: [h('button', { type: 'button', class: 'btn primary', 'data-sys': 'erp', onclick: () => this.create(ctx) }, 'New purchasing org')],
      load: async () => ({ rows: (await get('erp', '/v1/reference/purchasing-orgs')).data }),
      rowKey: (r) => r.code,
      onOpen: (r) => ctx.go(this.id, r.code),
      columns: [
        { label: 'Code', render: (o) => h('span', { class: 'id' }, o.code) },
        { label: 'Buying organisation', key: 'name' },
        { label: 'Company code', render: (o) => h('span', { class: 'mono' }, o.company_code) },
      ],
    });
  },
  async create(ctx) {
    const ok = await formModal({
      sys: 'erp', title: 'New purchasing organisation', submitLabel: 'Create purchasing org',
      fields: [
        { name: 'code', label: 'Code', required: true, placeholder: 'AMBR' },
        { name: 'name', label: 'Buying organisation', required: true, placeholder: 'Acme-BR' },
        { name: 'company_code', label: 'Company code', required: true, placeholder: 'BR01' },
      ],
      onSubmit: async (v) => (await post('erp', '/v1/reference/purchasing-orgs', { ...v, code: v.code.toUpperCase() })).data,
    });
    if (ok) { toast(`Purchasing org ${ok.code} created`); cache.invalidate('orgs'); ctx.go(this.id, ok.code, { reload: true }); }
  },
  async open(id, ctx) {
    let data;
    try {
      data = await get('erp', `/v1/reference/purchasing-orgs/${encodeURIComponent(id)}`);
    } catch (err) {
      toast(errorText(err), 'error');
      return ctx.go(this.id);
    }
    const o = data.data;
    const edit = async () => {
      const ok = await formModal({
        sys: 'erp', title: `Edit ${o.code}`, submitLabel: 'Save purchasing org',
        fields: [{ name: 'name', label: 'Buying organisation', value: o.name }, { name: 'company_code', label: 'Company code', value: o.company_code }],
        onSubmit: (v) => patch('erp', `/v1/reference/purchasing-orgs/${o.code}`, compact({ name: v.name !== o.name ? v.name : undefined, company_code: v.company_code !== o.company_code ? v.company_code : undefined })),
      });
      if (ok) { toast('Purchasing org saved'); cache.invalidate('orgs'); ctx.reload(); this.open(id, ctx); }
    };
    const remove = async () => {
      const ok = await confirmModal({
        sys: 'erp', title: `Delete ${o.code}?`, confirmLabel: 'Delete purchasing org', text: 'Refused with 409 PURCH_ORG_IN_USE while purchase orders reference it.',
        onConfirm: () => del('erp', `/v1/reference/purchasing-orgs/${o.code}`),
      });
      if (ok) { toast('Purchasing org deleted'); cache.invalidate('orgs'); closeDrawer({ silent: true }); ctx.go(this.id, null, { reload: true }); }
    };
    openDrawer({
      sys: 'erp', kicker: 'Purchasing organisation', title: `${o.code} ${o.name}`,
      actions: [h('button', { type: 'button', class: 'btn small', onclick: edit }, 'Edit'), h('button', { type: 'button', class: 'btn small danger', onclick: remove }, 'Delete')],
      onClose: () => ctx.go(this.id),
      tabs: [
        {
          label: 'Details',
          render: async () => {
            const pos = await get('erp', '/v1/purchase-orders', { purch_org: o.code, limit: 1 });
            return kv([['Company code', o.company_code], ['Purchase orders', link('erp/purchase-orders', null, `${pos.pagination.total} purchase orders`, null, { purch_org: o.code })]]);
          },
        },
        rawTab('erp', data, `GET /erp/v1/reference/purchasing-orgs/${o.code}`),
      ],
    });
  },
};

export const pages = [poPage, confPage, delPage, plantPage, orgPage];
