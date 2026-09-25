import { get, post, patch, del } from '../api.js';
import {
  h, table, kv, badge, fmtDate, fmtDateTime, relative, num, openDrawer, closeDrawer, formModal, confirmModal, toast, compact, errorText, setOptions,
} from '../ui.js';
import { listPage } from '../list.js';
import * as cache from '../cache.js';
import { link, xrefBox, rawTab, dialectNote } from './common.js';
import { STATUS as PO_STATUS } from './erp.js';

export const MILESTONES = { PLN: 'Planned', TND: 'Tendered', ITR: 'In transit', EXC: 'Exception', DLV: 'Delivered', CXL: 'Cancelled' };
const MODES = ['PARCEL', 'LTL', 'FTL', 'AIR', 'OCEAN'];
const HU_TYPES = ['PLT', 'CTN', 'CRT', 'OTH'];
const msBadge = (m) => badge(m.code || m, MILESTONES[m.code || m]);
const place = (loc) => (loc ? [loc.city, loc.country].filter(Boolean).join(', ') : '—');

// ═══ Shipments ══════════════════════════════════════════════════════════
const shipmentPage = {
  id: 'tms/shipments',
  sys: 'tms',
  nav: 'Shipments',
  title: 'Shipments',
  render(main, ctx) {
    return listPage(main, {
      id: this.id, sys: 'tms', paging: 'cursor', pageSize: 20, presetFilters: ctx.query,
      lede: 'Physical movements. TMS knows suppliers by SRM code, carriers by SCAC and orders only as poNumber references inside the contents.',
      dialect: 'TMS: cursor, {count, results, nextCursor}',
      filters: [
        { name: 'status', label: 'Milestone', type: 'select', options: Object.entries(MILESTONES).map(([v, l]) => ({ value: v, label: `${v} ${l}` })) },
        { name: 'supplierCode', label: 'Supplier', type: 'select', options: () => cache.supplierOptions() },
        { name: 'carrier', label: 'Carrier', type: 'select', options: async () => (await cache.carriers()).map((c) => ({ value: c.scac, label: `${c.name} (${c.scac})` })) },
        { name: 'poNumber', label: 'PO number', placeholder: '4500123458' },
      ],
      actions: [h('button', { type: 'button', class: 'btn primary', 'data-sys': 'tms', onclick: () => newShipment(ctx) }, 'New shipment')],
      load: async ({ filters, cursor, limit }) => {
        const r = await get('tms', '/v1/shipments', { ...filters, cursor, limit });
        return { rows: r.results, nextCursor: r.nextCursor };
      },
      rowKey: (r) => r.shipmentId,
      onOpen: (r) => ctx.go(this.id, r.shipmentId),
      columns: [
        { label: 'Shipment', render: (s) => h('span', null, h('span', { class: 'id' }, s.shipmentId), h('span', { class: 'sub mono' }, s.asnNumber)) },
        { label: 'Supplier', render: (s) => h('span', { class: 'mono' }, s.supplierCode) },
        { label: 'Milestone', render: (s) => h('span', null, msBadge(s.milestone), h('span', { class: 'sub' }, relative(s.milestone.since))) },
        { label: 'Carrier', render: (s) => h('span', null, s.carrier.name || s.carrier.scac, h('span', { class: 'sub mono' }, s.carrier.scac)) },
        { label: 'Route', render: (s) => h('span', null, place(s.route.origin), h('span', { class: 'sub' }, `to ${place(s.route.destination)}`)) },
        { label: 'ETA', render: (s) => h('span', null, fmtDate(s.schedule.estimatedArrival), h('span', { class: 'sub' }, relative(s.schedule.estimatedArrival))) },
        { label: 'POs', render: (s) => [...new Set(s.contents.map((c) => c.poNumber))].join(', ') },
      ],
    });
  },
  open: (id, ctx) => openShipment(id, ctx),
};

async function openShipment(id, ctx) {
  let s;
  try {
    s = await get('tms', `/v1/shipments/${encodeURIComponent(id)}`, { include: 'events' });
  } catch (err) {
    toast(errorText(err), 'error');
    return ctx.go(shipmentPage.id);
  }
  const code = s.milestone.code;
  const closed = ['DLV', 'CXL'].includes(code);
  const refresh = () => { cache.invalidate('shipments'); ctx.reload(); openShipment(id, ctx); };

  const tender = async () => {
    try {
      await post('tms', `/v1/shipments/${s.shipmentId}/tender`);
      toast('Shipment tendered to carrier');
      refresh();
    } catch (err) {
      toast(errorText(err), 'error');
    }
  };
  const cancel = async () => {
    const ok = await formModal({
      sys: 'tms', title: `Cancel shipment ${s.shipmentId}?`, submitLabel: 'Cancel shipment',
      intro: 'Business cancel or saga compensation. The matching ERP inbound delivery is not reversed automatically: that is the orchestrator\'s job.',
      fields: [{ name: 'reason', label: 'Reason', wide: true, value: 'Cancelled from dashboard' }],
      onSubmit: (v) => post('tms', `/v1/shipments/${s.shipmentId}/cancel`, compact(v)),
    });
    if (ok) { toast('Shipment cancelled'); refresh(); }
  };
  const remove = async () => {
    const ok = await confirmModal({
      sys: 'tms', title: `Delete draft ${s.shipmentId}?`, confirmLabel: 'Delete shipment',
      text: 'Only planned (PLN) shipments can be deleted. Anything already tendered has to be cancelled.',
      onConfirm: () => del('tms', `/v1/shipments/${s.shipmentId}`),
    });
    if (ok) { toast('Shipment deleted'); cache.invalidate('shipments'); closeDrawer({ silent: true }); ctx.go(shipmentPage.id, null, { reload: true }); }
  };

  openDrawer({
    sys: 'tms',
    kicker: `Shipment for ${s.supplierCode}`,
    title: h('span', { class: 'mono' }, s.shipmentId),
    subtitle: h('span', null, msBadge(s.milestone), ` ASN ${s.asnNumber}, ${s.carrier.name || s.carrier.scac}`),
    actions: [
      code === 'PLN' ? h('button', { type: 'button', class: 'btn small primary', 'data-sys': 'tms', onclick: tender }, 'Tender to carrier') : null,
      !closed && code !== 'PLN' ? h('button', { type: 'button', class: 'btn small primary', 'data-sys': 'tms', onclick: () => postEvent(s, refresh) }, 'Post tracking event') : null,
      !closed ? h('button', { type: 'button', class: 'btn small', onclick: () => editShipment(s, refresh) }, 'Edit') : null,
      !closed ? h('button', { type: 'button', class: 'btn small danger', onclick: cancel }, 'Cancel shipment') : null,
      code === 'PLN' ? h('button', { type: 'button', class: 'btn small danger', onclick: remove }, 'Delete') : null,
    ].filter(Boolean),
    onClose: () => ctx.go(shipmentPage.id),
    tabs: [
      { label: 'Details', render: () => shipmentDetails(s) },
      { label: 'Tracking', render: () => tracking(s) },
      { label: 'Across systems', render: () => shipmentAcross(s) },
      rawTab('tms', s, `GET /tms/v1/shipments/${s.shipmentId}?include=events`),
    ],
  });
}

function shipmentDetails(s) {
  const loc = (l) => (l ? h('span', null, h('strong', null, l.name), h('span', { class: 'sub mono' }, l.locationCode), h('span', { class: 'sub' }, [l.street, l.city, l.state, l.zip, l.country].filter(Boolean).join(', '))) : '—');
  return h('div', null,
    h('section', { class: 'cols-2' },
      kv([
        ['Origin', loc(s.route.origin)],
        ['Destination', loc(s.route.destination)],
      ]),
      kv([
        ['Carrier', `${s.carrier.name || ''} (${s.carrier.scac})`],
        ['Tracking ID', s.carrier.trackingId ? (s.carrier.trackingUrl ? h('a', { href: s.carrier.trackingUrl, target: '_blank', rel: 'noopener' }, s.carrier.trackingId) : h('span', { class: 'mono' }, s.carrier.trackingId)) : null],
        ['Planned ship', fmtDateTime(s.schedule.plannedShipDate)],
        ['Estimated arrival', `${fmtDateTime(s.schedule.estimatedArrival)} (${relative(s.schedule.estimatedArrival)})`],
        ['Milestone since', fmtDateTime(s.milestone.since)],
        ['Cancel reason', s.cancelReason || undefined],
      ])),
    h('section', null, h('h3', null, 'Contents'), h('div', { class: 'table-wrap standalone' }, table([
      { label: 'PO', render: (c) => link('erp/purchase-orders', c.poNumber, c.poNumber, 'id') },
      { label: 'Line', num: true, render: (c) => c.poLine },
      { label: 'Quantity', num: true, render: (c) => `${num(c.quantity.value)} ${c.quantity.uom}` },
      { label: 'Lot', render: (c) => h('span', { class: 'mono' }, c.lotNumber || '—') },
    ], s.contents))),
    h('section', null, h('h3', null, 'Handling units'), h('div', { class: 'table-wrap standalone' }, table([
      { label: 'Unit', render: (u) => h('span', { class: 'mono' }, u.huId) },
      { label: 'Type', key: 'type' },
      { label: 'Weight', num: true, render: (u) => (u.weight ? `${num(u.weight.value)} ${u.weight.unit}` : '—') },
    ], s.handlingUnits || [], { empty: { title: 'No handling units', text: 'Pallets and cartons are optional.' } }))),
    h('section', null, h('div', { class: 'callout', style: { '--sys-color': 'var(--tms)' } },
      'PO line numbers are integers here (10) while ERP uses item numbers ("00010"). The façade converts between them.')));
}

function tracking(s) {
  const events = [...(s.events || [])].reverse();
  if (!events.length) return h('p', { class: 'muted' }, 'No tracking events yet. Tender the shipment, then post events.');
  return h('div', null,
    dialectNote(`Event codes move the milestone: PU, DEP, ARR, OFD and RES mean in transit; EXC raises an exception; DLV closes the shipment.`),
    h('ol', { class: 'timeline' }, events.map((e) => h('li', { class: e.eventCode === 'EXC' ? 'exc' : e.eventCode === 'DLV' ? 'dlv' : null },
      h('div', { class: 'what' }, h('span', { class: 'mono' }, e.eventCode), ' ', e.description),
      h('div', { class: 'when' }, fmtDateTime(e.occurredAt), e.location ? `, ${e.location}` : '')))));
}

async function shipmentAcross(s) {
  const poNumbers = [...new Set(s.contents.map((c) => c.poNumber))];
  const [sup, dels, pos] = await Promise.all([
    get('srm', `/v1/suppliers/${s.supplierCode}`, { expand: 'sites' }).catch(() => null),
    get('erp', '/v1/inbound-deliveries', { asn_reference: s.asnNumber }).then((r) => r.data).catch(() => null),
    get('erp', '/v1/purchase-orders', { po_number: poNumbers.join(','), limit: 50 }).then((r) => r.data).catch(() => null),
  ]);
  const matching = dels && sup ? dels.filter((d) => d.vendor_id === sup.erpVendorNumber) : dels;
  const originKnown = sup && sup.sites && sup.sites.some((x) => s.route.origin && x.siteCode === s.route.origin.locationCode);
  return h('div', null,
    dialectNote('The ASN saga writes to ERP first (inbound delivery) and TMS second (shipment). A cancelled shipment should have a reversed delivery.'),
    xrefBox('srm', 'Supplier', `GET /srm/v1/suppliers/${s.supplierCode}`, sup ? kv([
      ['Supplier', link('srm/suppliers', sup.supplierCode, `${sup.name.legal} (${sup.supplierCode})`)],
      ['Status', badge(sup.status)],
      ['ERP vendor', h('span', { class: 'mono' }, sup.erpVendorNumber)],
      ['Origin site', originKnown ? link('srm/sites', s.route.origin.locationCode, s.route.origin.locationCode, 'mono') : `${s.route.origin ? s.route.origin.locationCode : '—'} (not an SRM site of this supplier)`],
    ]) : h('p', null, 'Supplier not found in SRM.')),
    xrefBox('erp', 'Inbound delivery for this ASN', `GET /erp/v1/inbound-deliveries?asn_reference=${s.asnNumber}`, matching ? h('div', { class: 'table-wrap standalone' }, table([
      { label: 'Delivery', render: (d) => link('erp/inbound-deliveries', d.delivery_no, d.delivery_no, 'id') },
      { label: 'Status', render: (d) => badge(d.status) },
      { label: 'Quantity', num: true, render: (d) => num(d.items.reduce((a, i) => a + Number(i.quantity), 0)) },
      { label: 'Posted', render: (d) => fmtDateTime(d.posted_at) },
    ], matching, { empty: { title: 'No ERP delivery', text: s.milestone.code === 'PLN' ? 'Expected: planned shipments are not yet posted to ERP.' : 'This shipment has no ERP counterpart, a reconciliation finding.' } })) : h('p', null, 'ERP is unavailable.')),
    xrefBox('erp', 'Purchase orders in the contents', `GET /erp/v1/purchase-orders?po_number=${poNumbers.join(',')}`, pos ? h('div', { class: 'table-wrap standalone' }, table([
      { label: 'PO', render: (p) => link('erp/purchase-orders', p.po_number, p.po_number, 'id') },
      { label: 'Status', render: (p) => badge(p.status_code, PO_STATUS[p.status_code]) },
      { label: 'Plant', render: (p) => p.plant },
      { label: 'Delivery date', render: (p) => fmtDate(p.delivery_date) },
    ], pos)) : h('p', null, 'ERP is unavailable.')));
}

// ── Shipment forms ─────────────────────────────────────────────────────
const siteToLocation = (x) => ({ locationCode: x.siteCode, name: x.name, street: x.address.line1, city: x.address.city, state: x.address.region, zip: x.address.postalCode, country: x.address.countryCode });
const plantToLocation = (p) => ({ locationCode: p.site_code, name: p.name, street: p.street, city: p.city, state: p.region, zip: p.postal_code, country: p.country });

async function newShipment(ctx) {
  let sites = [];
  const inTwoDays = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 13) + ':00:00Z';
  const inSixDays = new Date(Date.now() + 6 * 86400000).toISOString().slice(0, 13) + ':00:00Z';
  const created = await formModal({
    sys: 'tms',
    title: 'New shipment',
    intro: 'Origin comes from SRM supplier sites and destination from ERP plants, so this form already aggregates three systems. The ERP inbound delivery is not created here.',
    fields: [
      {
        name: 'supplierCode', label: 'Supplier', type: 'select', required: true, options: () => cache.supplierOptions(),
        onChange: async (code, sel, controls) => {
          if (!controls || !controls.originSite) return;
          sites = code ? (await get('srm', `/v1/suppliers/${code}/sites`)).items.filter((x) => x.type !== 'REMIT_TO') : [];
          setOptions(controls.originSite, sites.map((x) => ({ value: x.siteCode, label: `${x.siteCode} ${x.address.city || ''}` })), { emptyLabel: sites.length ? undefined : 'No sites' });
        },
      },
      { name: 'asnNumber', label: 'ASN number', required: true, value: `ASN-${Date.now().toString().slice(-6)}` },
      { name: 'originSite', label: 'Origin (SRM site)', type: 'select', required: true, options: [] },
      { name: 'destinationPlant', label: 'Destination (ERP plant)', type: 'select', required: true, options: async () => (await cache.plants()).map((p) => ({ value: p.plant_code, label: `${p.plant_code} ${p.name}` })) },
      { name: 'scac', label: 'Carrier', type: 'select', required: true, options: async () => (await cache.carriers()).map((c) => ({ value: c.scac, label: `${c.name} (${c.scac})` })) },
      { name: 'trackingId', label: 'Tracking ID' },
      { name: 'plannedShipDate', label: 'Planned ship (UTC)', type: 'datetime', required: true, value: inTwoDays },
      { name: 'estimatedArrival', label: 'Estimated arrival (UTC)', type: 'datetime', required: true, value: inSixDays },
      {
        name: 'contents', label: 'Contents', type: 'lines', value: [{ poLine: 10, uom: 'EA' }], addLabel: 'Add line',
        columns: [
          { name: 'poNumber', label: 'PO number' },
          { name: 'poLine', label: 'PO line', type: 'number', min: 1, step: '10' },
          { name: 'value', label: 'Quantity', type: 'number', min: 0 },
          { name: 'uom', label: 'UoM' },
          { name: 'lotNumber', label: 'Lot' },
        ],
      },
      {
        name: 'handlingUnits', label: 'Handling units', type: 'lines', value: [], addLabel: 'Add handling unit',
        columns: [
          { name: 'huId', label: 'Unit ID' },
          { name: 'type', label: 'Type', type: 'select', required: true, options: HU_TYPES },
          { name: 'weight', label: 'Weight', type: 'number', min: 0 },
          { name: 'unit', label: 'Unit', type: 'select', required: true, options: ['kg', 'lb'] },
        ],
      },
      { name: 'tender', label: 'Tender to the carrier right away', type: 'checkbox', value: true, wide: true },
    ],
    submitLabel: 'Create shipment',
    onSubmit: async (v) => {
      const site = sites.find((x) => x.siteCode === v.originSite);
      const plant = (await cache.plants()).find((p) => p.plant_code === v.destinationPlant);
      const body = compact({
        asnNumber: v.asnNumber,
        supplierCode: v.supplierCode,
        carrier: { scac: v.scac, trackingId: v.trackingId },
        route: { origin: site ? siteToLocation(site) : undefined, destination: plant ? plantToLocation(plant) : undefined },
        schedule: { plannedShipDate: v.plannedShipDate, estimatedArrival: v.estimatedArrival },
        contents: v.contents.filter((c) => c.poNumber).map((c) => ({ poNumber: c.poNumber, poLine: c.poLine, quantity: { value: c.value, uom: c.uom || 'EA' }, lotNumber: c.lotNumber })),
        handlingUnits: v.handlingUnits.filter((u) => u.huId).map((u) => ({ huId: u.huId, type: u.type, weight: u.weight !== undefined ? { value: u.weight, unit: u.unit } : undefined })),
        tender: v.tender,
      });
      return post('tms', '/v1/shipments', body);
    },
  });
  if (created) {
    toast(`Shipment ${created.shipmentId} created (${created.milestone.code})`);
    cache.invalidate('shipments');
    ctx.go(shipmentPage.id, created.shipmentId, { reload: true });
  }
}

async function editShipment(s, refresh) {
  const early = ['PLN', 'TND'].includes(s.milestone.code);
  const ok = await formModal({
    sys: 'tms', title: `Edit shipment ${s.shipmentId}`, submitLabel: 'Save shipment',
    intro: early ? 'Carrier and schedule can still change because the shipment has not been picked up.' : 'After pickup only the tracking ID and estimated arrival can change (409 FIELD_LOCKED otherwise).',
    fields: [
      { name: 'scac', label: 'Carrier', type: 'select', required: true, disabled: !early, value: s.carrier.scac, options: async () => (await cache.carriers()).map((c) => ({ value: c.scac, label: `${c.name} (${c.scac})` })) },
      { name: 'trackingId', label: 'Tracking ID', value: s.carrier.trackingId },
      { name: 'plannedShipDate', label: 'Planned ship (UTC)', type: 'datetime', disabled: !early, value: s.schedule.plannedShipDate },
      { name: 'estimatedArrival', label: 'Estimated arrival (UTC)', type: 'datetime', value: s.schedule.estimatedArrival },
    ],
    onSubmit: (v) => {
      const same = (a, b) => (a && b ? new Date(a).getTime() === new Date(b).getTime() : a === b);
      return patch('tms', `/v1/shipments/${s.shipmentId}`, compact({
        carrier: { scac: early && v.scac !== s.carrier.scac ? v.scac : undefined, trackingId: v.trackingId !== s.carrier.trackingId ? v.trackingId : undefined },
        schedule: {
          plannedShipDate: early && !same(v.plannedShipDate, s.schedule.plannedShipDate) ? v.plannedShipDate : undefined,
          estimatedArrival: !same(v.estimatedArrival, s.schedule.estimatedArrival) ? v.estimatedArrival : undefined,
        },
      }));
    },
  });
  if (ok) { toast('Shipment saved'); refresh(); }
}

async function postEvent(s, refresh) {
  const codes = await cache.eventCodes();
  const ok = await formModal({
    sys: 'tms', title: `Post tracking event for ${s.shipmentId}`, submitLabel: 'Post event',
    intro: 'This is how a carrier update arrives. Watch the façade status change on the next GET.',
    fields: [
      { name: 'eventCode', label: 'Event', type: 'select', required: true, options: codes.map((c) => ({ value: c.code, label: `${c.code} ${c.description} (to ${c.resultingMilestone})` })) },
      { name: 'location', label: 'Location', placeholder: 'Memphis, TN, US' },
      { name: 'description', label: 'Description', wide: true, placeholder: 'Defaults to the event code text' },
      { name: 'occurredAt', label: 'Occurred at (UTC)', type: 'datetime', help: 'Leave empty for now' },
      { name: 'newEstimatedArrival', label: 'New estimated arrival (UTC)', type: 'datetime' },
    ],
    onSubmit: (v) => post('tms', `/v1/shipments/${s.shipmentId}/events`, compact(v)),
  });
  if (ok) { toast(`Event posted, milestone is now ${ok.milestone.code}`); refresh(); }
}

// ═══ Carriers ═══════════════════════════════════════════════════════════
const carrierPage = {
  id: 'tms/carriers',
  sys: 'tms',
  nav: 'Carriers',
  title: 'Carriers',
  render(main, ctx) {
    return listPage(main, {
      id: this.id, sys: 'tms', paging: 'none',
      lede: 'Carrier master. The façade accepts common carrier codes (UPS) and TMS stores the SCAC (UPSN), so this list is the translation table.',
      dialect: 'TMS: {count, results}',
      actions: [h('button', { type: 'button', class: 'btn primary', 'data-sys': 'tms', onclick: () => this.edit(null, ctx) }, 'New carrier')],
      load: async () => ({ rows: (await get('tms', '/v1/carriers')).results }),
      rowKey: (r) => r.carrierCode,
      onOpen: (r) => ctx.go(this.id, r.carrierCode),
      columns: [
        { label: 'Carrier code', render: (c) => h('span', { class: 'id' }, c.carrierCode) },
        { label: 'SCAC', render: (c) => h('span', { class: 'mono' }, c.scac) },
        { label: 'Name', key: 'name' },
        { label: 'Mode', key: 'mode' },
        { label: 'Tracking link', render: (c) => (c.trackingUrlTemplate ? 'Yes' : 'No') },
      ],
    });
  },
  async edit(c, ctx) {
    const ok = await formModal({
      sys: 'tms', title: c ? `Edit ${c.carrierCode}` : 'New carrier', submitLabel: c ? 'Save carrier' : 'Create carrier',
      fields: [
        c ? null : { name: 'carrierCode', label: 'Carrier code', required: true, placeholder: 'ACME' },
        c ? null : { name: 'scac', label: 'SCAC', required: true, placeholder: 'ACMF', help: '2 to 4 letters' },
        { name: 'name', label: 'Name', required: !c, value: c && c.name, wide: true },
        { name: 'mode', label: 'Mode', type: 'select', required: true, value: c ? c.mode : 'LTL', options: MODES },
        { name: 'trackingUrlTemplate', label: 'Tracking URL template', value: c && c.trackingUrlTemplate, wide: true, help: 'Use {trackingId} as the placeholder' },
      ].filter(Boolean),
      onSubmit: (v) => (c
        ? patch('tms', `/v1/carriers/${c.carrierCode}`, compact({ name: v.name !== c.name ? v.name : undefined, mode: v.mode !== c.mode ? v.mode : undefined, trackingUrlTemplate: (v.trackingUrlTemplate || null) !== c.trackingUrlTemplate ? v.trackingUrlTemplate || null : undefined }))
        : post('tms', '/v1/carriers', compact({ ...v, carrierCode: v.carrierCode.toUpperCase(), scac: v.scac.toUpperCase() }))),
    });
    if (ok) {
      toast(c ? 'Carrier saved' : `Carrier ${ok.carrierCode} created`);
      cache.invalidate('carriers');
      ctx.go(this.id, ok.carrierCode, { reload: true });
    }
  },
  async open(id, ctx) {
    let c;
    try {
      c = await get('tms', `/v1/carriers/${encodeURIComponent(id)}`);
    } catch (err) {
      toast(errorText(err), 'error');
      return ctx.go(this.id);
    }
    const remove = async () => {
      const ok = await confirmModal({ sys: 'tms', title: `Delete ${c.carrierCode}?`, confirmLabel: 'Delete carrier', text: 'Refused with 409 CARRIER_IN_USE while shipments reference its SCAC.', onConfirm: () => del('tms', `/v1/carriers/${c.carrierCode}`) });
      if (ok) { toast('Carrier deleted'); cache.invalidate('carriers'); closeDrawer({ silent: true }); ctx.go(this.id, null, { reload: true }); }
    };
    openDrawer({
      sys: 'tms', kicker: `${c.mode} carrier`, title: c.name, subtitle: h('span', { class: 'mono' }, `${c.carrierCode} / SCAC ${c.scac}`),
      actions: [h('button', { type: 'button', class: 'btn small', onclick: () => this.edit(c, ctx) }, 'Edit'), h('button', { type: 'button', class: 'btn small danger', onclick: remove }, 'Delete')],
      onClose: () => ctx.go(this.id),
      tabs: [
        {
          label: 'Details',
          render: () => h('div', null,
            kv([['Tracking URL template', c.trackingUrlTemplate]]),
            h('section', null, h('h3', null, 'Shipments by milestone'), h('div', { class: 'table-wrap standalone' }, table([
              { label: 'Milestone', render: ([k]) => badge(k, MILESTONES[k]) },
              { label: 'Shipments', num: true, render: ([k, n]) => link('tms/shipments', null, String(n), null, { status: k, carrier: c.scac }) },
            ], Object.entries(c.shipmentsByMilestone || {}), { empty: { title: 'No shipments', text: 'This carrier can be deleted.' } })))),
        },
        rawTab('tms', c, `GET /tms/v1/carriers/${c.carrierCode}`),
      ],
    });
  },
};

export const pages = [shipmentPage, carrierPage];
