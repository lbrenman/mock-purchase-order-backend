import { get, post, patch, del } from '../api.js';
import {
  h, table, kv, badge, fmtDate, fmtDateTime, relative, openDrawer, closeDrawer, formModal, confirmModal, toast, compact, errorText, mount,
} from '../ui.js';
import { listPage } from '../list.js';
import * as cache from '../cache.js';
import { link, xrefBox, rawTab, dialectNote } from './common.js';
import { STATUS as PO_STATUS } from './erp.js';

const STATUSES = ['ACTIVE', 'ON_HOLD', 'BLOCKED'];
const TIERS = ['STRATEGIC', 'PREFERRED', 'APPROVED', 'CONDITIONAL'];
const RISK = ['LOW', 'MEDIUM', 'HIGH'];
const SITE_TYPES = ['SHIP_FROM', 'REMIT_TO', 'MANUFACTURING'];
const ROLES = ['PRIMARY', 'LOGISTICS', 'QUALITY', 'FINANCE'];
const SCOPES = ['supplier-orders.read', 'supplier-orders.write'];
const CONSUMER_TYPES = ['supplier-partner', 'internal-application', 'operations-support'];
const label = (s) => s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, ' ');

const nameOf = (s) => s.name.trading || s.name.legal;

// ═══ Suppliers ══════════════════════════════════════════════════════════
const supplierFields = (s = null) => [
  s ? null : { name: 'supplierCode', label: 'Supplier code', placeholder: 'leave empty to assign the next SUP- number' },
  { name: 'erpVendorNumber', label: 'ERP vendor number', required: !s, value: s && s.erpVendorNumber, help: '10 digits; the key ERP purchase orders use' },
  { name: 'legal', label: 'Legal name', required: !s, value: s && s.name.legal, wide: true },
  { name: 'trading', label: 'Trading name', value: s && s.name.trading },
  { name: 'countryCode', label: 'Country (ISO-2)', required: !s, value: s && s.countryCode },
  { name: 'status', label: 'Status', type: 'select', required: true, value: s ? s.status : 'ACTIVE', options: STATUSES.map((v) => ({ value: v, label: label(v) })) },
  { name: 'statusReason', label: 'Status reason', value: s && s.statusReason },
  { name: 'tier', label: 'Tier', type: 'select', required: true, value: s ? s.classification.tier : 'APPROVED', options: TIERS.map((v) => ({ value: v, label: label(v) })) },
  { name: 'riskRating', label: 'Risk rating', type: 'select', required: true, value: s ? s.classification.riskRating : 'MEDIUM', options: RISK.map((v) => ({ value: v, label: label(v) })) },
  { name: 'duns', label: 'D-U-N-S number', value: s && s.duns },
  { name: 'onboardedOn', label: 'Onboarded on', type: 'date', value: s && s.onboardedOn },
  { name: 'portal', label: 'Uses the supplier portal', type: 'checkbox', value: s ? s.capabilities.portal : true },
  { name: 'asn', label: 'Allowed to send ASNs', type: 'checkbox', value: s ? s.capabilities.asn : true },
].filter(Boolean);

function supplierBody(v, s) {
  const changed = (a, b) => (s && a === b ? undefined : a);
  return compact({
    supplierCode: v.supplierCode,
    erpVendorNumber: changed(v.erpVendorNumber, s && s.erpVendorNumber),
    name: { legal: changed(v.legal, s && s.name.legal), trading: changed(v.trading, s && s.name.trading) },
    countryCode: changed(v.countryCode && v.countryCode.toUpperCase(), s && s.countryCode),
    status: changed(v.status, s && s.status),
    statusReason: changed(v.statusReason, s && s.statusReason),
    classification: { tier: changed(v.tier, s && s.classification.tier), riskRating: changed(v.riskRating, s && s.classification.riskRating) },
    capabilities: { portal: changed(v.portal, s && s.capabilities.portal), asn: changed(v.asn, s && s.capabilities.asn) },
    duns: changed(v.duns, s && s.duns),
    onboardedOn: changed(v.onboardedOn, s && s.onboardedOn),
  });
}

const supplierPage = {
  id: 'srm/suppliers',
  sys: 'srm',
  nav: 'Suppliers',
  title: 'Suppliers',
  render(main, ctx) {
    return listPage(main, {
      id: this.id, sys: 'srm', paging: 'offset', pageSize: 20, presetFilters: ctx.query,
      lede: 'Supplier master data and governance status. ON_HOLD and BLOCKED suppliers are what the façade uses to refuse writes.',
      dialect: 'SRM: offset/limit, {total, offset, limit, items}',
      filters: [
        { name: 'q', label: 'Name contains', placeholder: 'Apex' },
        { name: 'status', label: 'Status', type: 'select', options: STATUSES.map((v) => ({ value: v, label: label(v) })) },
        { name: 'tier', label: 'Tier', type: 'select', options: TIERS.map((v) => ({ value: v, label: label(v) })) },
        { name: 'country', label: 'Country', placeholder: 'US' },
      ],
      actions: [h('button', { type: 'button', class: 'btn primary', 'data-sys': 'srm', onclick: () => this.create(ctx) }, 'New supplier')],
      load: async ({ filters, offset, limit }) => {
        const r = await get('srm', '/v1/suppliers', { ...filters, country: filters.country && filters.country.toUpperCase(), offset, limit });
        return { rows: r.items, total: r.total };
      },
      rowKey: (r) => r.supplierCode,
      onOpen: (r) => ctx.go(this.id, r.supplierCode),
      columns: [
        { label: 'Supplier', render: (s) => h('span', null, h('span', { class: 'id' }, s.supplierCode), h('span', { class: 'sub' }, s.name.legal)) },
        { label: 'Status', render: (s) => h('span', null, badge(s.status, label(s.status)), s.statusReason ? h('span', { class: 'sub' }, s.statusReason) : null) },
        { label: 'Tier and risk', render: (s) => h('span', null, label(s.classification.tier), h('span', { class: 'sub' }, `${label(s.classification.riskRating)} risk`)) },
        { label: 'Country', render: (s) => s.countryCode },
        { label: 'ERP vendor', render: (s) => h('span', { class: 'mono' }, s.erpVendorNumber) },
        { label: 'Channels', render: (s) => [s.capabilities.portal ? 'Portal' : null, s.capabilities.asn ? 'ASN' : null].filter(Boolean).join(', ') || 'None' },
      ],
    });
  },
  async create(ctx) {
    const ok = await formModal({
      sys: 'srm', title: 'New supplier', intro: 'Creates the master record in SRM. Use an ERP vendor number that already has purchase orders to see them join up.',
      fields: supplierFields(), submitLabel: 'Create supplier',
      onSubmit: (v) => post('srm', '/v1/suppliers', supplierBody(v, null)),
    });
    if (ok) { toast(`Supplier ${ok.supplierCode} created`); cache.invalidate('suppliers'); cache.clearXref(); ctx.go(this.id, ok.supplierCode, { reload: true }); }
  },
  open: (id, ctx) => openSupplier(id, ctx),
};

async function openSupplier(code, ctx) {
  let s;
  try {
    s = await get('srm', `/v1/suppliers/${encodeURIComponent(code)}`);
  } catch (err) {
    toast(errorText(err), 'error');
    return ctx.go(supplierPage.id);
  }
  const refresh = () => { cache.invalidate('suppliers'); cache.clearXref(); ctx.reload(); openSupplier(code, ctx); };
  const edit = async () => {
    const ok = await formModal({ sys: 'srm', title: `Edit ${nameOf(s)}`, fields: supplierFields(s), submitLabel: 'Save supplier', onSubmit: (v) => patch('srm', `/v1/suppliers/${s.supplierCode}`, supplierBody(v, s)) });
    if (ok) { toast('Supplier saved'); refresh(); }
  };
  const setStatus = async (status) => {
    const ok = await formModal({
      sys: 'srm', title: status === 'ACTIVE' ? `Reactivate ${nameOf(s)}` : `${status === 'BLOCKED' ? 'Block' : 'Put on hold'}: ${nameOf(s)}`,
      intro: status === 'ACTIVE' ? 'Clears the status reason.' : 'Write operations through the façade (acknowledgements, ASNs) will be refused for this supplier.',
      fields: status === 'ACTIVE' ? [] : [{ name: 'statusReason', label: 'Reason', required: true, wide: true, value: status === 'BLOCKED' ? 'Blocked by supplier governance' : 'Quality hold pending corrective action' }],
      submitLabel: status === 'ACTIVE' ? 'Reactivate supplier' : status === 'BLOCKED' ? 'Block supplier' : 'Put on hold',
      onSubmit: (v) => patch('srm', `/v1/suppliers/${s.supplierCode}`, compact({ status, statusReason: v.statusReason })),
    });
    if (ok) { toast(`Supplier is now ${label(status).toLowerCase()}`); refresh(); }
  };
  const remove = async () => {
    const ok = await confirmModal({
      sys: 'srm', title: `Delete ${nameOf(s)}?`, confirmLabel: 'Delete supplier',
      text: 'Removes the supplier with its sites and contacts. SRM refuses while consumer entitlements reference it (409). ERP purchase orders for this vendor will no longer resolve.',
      onConfirm: () => del('srm', `/v1/suppliers/${s.supplierCode}`),
    });
    if (ok) { toast('Supplier deleted'); cache.invalidate('suppliers'); cache.clearXref(); closeDrawer({ silent: true }); ctx.go(supplierPage.id, null, { reload: true }); }
  };
  openDrawer({
    sys: 'srm',
    kicker: `Supplier, ${label(s.classification.tier).toLowerCase()} tier`,
    title: s.name.legal,
    subtitle: h('span', null, h('span', { class: 'mono' }, s.supplierCode), ' ', badge(s.status, label(s.status)), s.statusReason ? ` ${s.statusReason}` : ''),
    actions: [
      h('button', { type: 'button', class: 'btn small', onclick: edit }, 'Edit'),
      s.status !== 'ON_HOLD' ? h('button', { type: 'button', class: 'btn small', onclick: () => setStatus('ON_HOLD') }, 'Put on hold') : null,
      s.status !== 'BLOCKED' ? h('button', { type: 'button', class: 'btn small danger', onclick: () => setStatus('BLOCKED') }, 'Block') : null,
      s.status !== 'ACTIVE' ? h('button', { type: 'button', class: 'btn small primary', 'data-sys': 'srm', onclick: () => setStatus('ACTIVE') }, 'Reactivate') : null,
      h('button', { type: 'button', class: 'btn small', onclick: () => editSite(s.supplierCode, null, refresh) }, 'Add site'),
      h('button', { type: 'button', class: 'btn small', onclick: () => editContact(s.supplierCode, null, refresh) }, 'Add contact'),
      h('button', { type: 'button', class: 'btn small danger', onclick: remove }, 'Delete'),
    ].filter(Boolean),
    onClose: () => ctx.go(supplierPage.id),
    tabs: [
      { label: 'Details', render: () => supplierDetails(s, refresh) },
      { label: 'Access', render: () => supplierAccess(s) },
      { label: 'Across systems', render: () => supplierAcross(s) },
      rawTab('srm', s, `GET /srm/v1/suppliers/${s.supplierCode}`),
    ],
  });
}

function supplierDetails(s, refresh) {
  return h('div', null,
    h('section', { class: 'cols-2' },
      kv([
        ['Trading name', s.name.trading],
        ['ERP vendor number', h('span', { class: 'mono' }, s.erpVendorNumber)],
        ['Country', s.countryCode],
        ['D-U-N-S', s.duns],
      ]),
      kv([
        ['Tier', label(s.classification.tier)],
        ['Risk rating', label(s.classification.riskRating)],
        ['Channels', `Portal ${s.capabilities.portal ? 'on' : 'off'}, ASN ${s.capabilities.asn ? 'on' : 'off'}`],
        ['Onboarded', `${fmtDate(s.onboardedOn)} (${relative(s.onboardedOn)})`],
        ['Updated', fmtDateTime(s.updatedAt)],
      ])),
    h('section', null,
      h('h3', null, 'Sites'),
      h('div', { class: 'table-wrap standalone' }, table([
        { label: 'Site', render: (x) => link('srm/sites', x.siteCode, x.siteCode, 'id') },
        { label: 'Type', render: (x) => label(x.type) },
        { label: 'Name and address', render: (x) => h('span', null, x.name, h('span', { class: 'sub' }, [x.address.line1, x.address.city, x.address.region, x.address.countryCode].filter(Boolean).join(', '))) },
        { label: 'Active', render: (x) => badge(String(x.active), x.active ? 'Active' : 'Inactive') },
        { label: '', render: (x) => h('div', { class: 'inline-actions' },
          h('button', { type: 'button', class: 'btn small', onclick: () => editSite(s.supplierCode, x, refresh) }, 'Edit'),
          h('button', { type: 'button', class: 'btn small danger', onclick: () => deleteSite(x, refresh) }, 'Delete')) },
      ], s.sites || [], { empty: { title: 'No sites', text: 'Add a ship-from site so TMS shipments can use it as origin.' } }))),
    h('section', null,
      h('h3', null, 'Contacts'),
      h('div', { class: 'table-wrap standalone' }, table([
        { label: 'Contact', render: (c) => h('span', null, c.name, h('span', { class: 'sub mono' }, c.contactId)) },
        { label: 'Role', render: (c) => label(c.role) },
        { label: 'Email', render: (c) => h('a', { href: `mailto:${c.email}` }, c.email) },
        { label: 'Phone', key: 'phone' },
        { label: '', render: (c) => h('div', { class: 'inline-actions' },
          h('button', { type: 'button', class: 'btn small', onclick: () => editContact(s.supplierCode, c, refresh) }, 'Edit'),
          h('button', { type: 'button', class: 'btn small danger', onclick: () => deleteContact(c, refresh) }, 'Delete')) },
      ], s.contacts || [], { empty: { title: 'No contacts', text: 'Add a primary contact.' } }))));
}

async function supplierAccess(s) {
  const all = (await get('srm', '/v1/entitlements')).items;
  const granted = all.filter((e) => e.allSuppliers || e.suppliers.includes(s.supplierCode));
  const result = h('div');
  const runCheck = async (consumerId, scope) => {
    try {
      const r = await get('srm', `/v1/entitlements/${encodeURIComponent(consumerId)}/check`, { scope, supplierCode: s.supplierCode });
      mount(result, h('div', { class: 'callout', style: { '--sys-color': 'var(--srm)' } },
        h('span', { class: r.allowed ? 'result-allowed' : 'result-denied' }, r.allowed ? 'Allowed' : 'Denied'), ` ${r.consumerId} with ${r.scope}: ${r.reason}`));
    } catch (err) {
      mount(result, h('div', { class: 'form-error' }, errorText(err)));
    }
  };
  return h('div', null,
    dialectNote('Consumers that may see or act for this supplier. The façade calls the check endpoint before every request.'),
    h('div', { class: 'table-wrap standalone' }, table([
      { label: 'Consumer', render: (e) => h('span', null, link('srm/entitlements', e.consumerId, e.displayName), h('span', { class: 'sub mono' }, e.consumerId)) },
      { label: 'Grant', render: (e) => (e.allSuppliers ? 'All suppliers' : `${e.suppliers.length} supplier${e.suppliers.length === 1 ? '' : 's'}`) },
      { label: 'Scopes', render: (e) => e.scopes.map((x) => x.replace('supplier-orders.', '')).join(', ') },
      { label: 'Active', render: (e) => badge(String(e.active), e.active ? 'Active' : 'Inactive') },
      { label: 'Check write access', render: (e) => h('button', { type: 'button', class: 'btn small', onclick: () => runCheck(e.consumerId, 'supplier-orders.write') }, 'Check') },
    ], granted, { empty: { title: 'No consumer can see this supplier', text: 'Grant access on the Entitlements page.' } })),
    h('section', null, result));
}

async function supplierAcross(s) {
  const [pos, shipments] = await Promise.all([
    get('erp', '/v1/purchase-orders', { vendor_id: s.erpVendorNumber, limit: 100 }).catch(() => null),
    get('tms', '/v1/shipments', { supplierCode: s.supplierCode, limit: 100 }).then((r) => r.results).catch(() => null),
  ]);
  return h('div', null,
    dialectNote(`ERP knows this supplier only as vendor ${s.erpVendorNumber}; TMS knows it as ${s.supplierCode}. SRM is the bridge.`),
    xrefBox('erp', `Purchase orders${pos ? ` (${pos.pagination.total})` : ''}`, `GET /erp/v1/purchase-orders?vendor_id=${s.erpVendorNumber}`, pos ? h('div', { class: 'table-wrap standalone' }, table([
      { label: 'PO', render: (p) => link('erp/purchase-orders', p.po_number, p.po_number, 'id') },
      { label: 'Status', render: (p) => badge(p.status_code, PO_STATUS[p.status_code]) },
      { label: 'Plant', render: (p) => p.plant },
      { label: 'Delivery', render: (p) => fmtDate(p.delivery_date) },
    ], pos.data, { empty: { title: 'No purchase orders', text: 'ERP has no orders for this vendor number.' } })) : h('p', null, 'ERP is unavailable.')),
    xrefBox('tms', `Shipments${shipments ? ` (${shipments.length})` : ''}`, `GET /tms/v1/shipments?supplierCode=${s.supplierCode}`, shipments ? h('div', { class: 'table-wrap standalone' }, table([
      { label: 'Shipment', render: (x) => link('tms/shipments', x.shipmentId, x.shipmentId, 'id') },
      { label: 'ASN', render: (x) => h('span', { class: 'mono' }, x.asnNumber) },
      { label: 'Milestone', render: (x) => badge(x.milestone.code, x.milestone.description.split(' - ')[0]) },
      { label: 'ETA', render: (x) => fmtDateTime(x.schedule.estimatedArrival) },
    ], shipments, { empty: { title: 'No shipments', text: 'TMS has no shipments for this supplier.' } })) : h('p', null, 'TMS is unavailable.')));
}

// ── Site & contact forms (shared by supplier drawer and list pages) ───
async function editSite(supplierCode, site, refresh) {
  const ok = await formModal({
    sys: 'srm', title: site ? `Edit site ${site.siteCode}` : 'Add site', submitLabel: site ? 'Save site' : 'Add site',
    intro: site ? null : 'Ship-from sites become shipment origins in TMS.',
    fields: [
      site ? null : { name: 'siteCode', label: 'Site code', required: true, placeholder: 'SUP-XXX-01' },
      { name: 'type', label: 'Type', type: 'select', required: true, value: site ? site.type : 'SHIP_FROM', options: SITE_TYPES.map((v) => ({ value: v, label: label(v) })) },
      { name: 'name', label: 'Name', required: !site, value: site && site.name, wide: true },
      { name: 'line1', label: 'Street', value: site && site.address.line1, wide: true },
      { name: 'city', label: 'City', value: site && site.address.city },
      { name: 'region', label: 'Region', value: site && site.address.region },
      { name: 'postalCode', label: 'Postal code', value: site && site.address.postalCode },
      { name: 'countryCode', label: 'Country (ISO-2)', required: !site, value: site && site.address.countryCode },
      { name: 'active', label: 'Active', type: 'checkbox', value: site ? site.active : true },
    ].filter(Boolean),
    onSubmit: (v) => {
      const body = compact({
        siteCode: v.siteCode, type: v.type, name: v.name, active: v.active,
        address: { line1: v.line1, city: v.city, region: v.region, postalCode: v.postalCode, countryCode: v.countryCode && v.countryCode.toUpperCase() },
      });
      if (site) {
        delete body.siteCode;
        if (body.address && !body.address.countryCode) body.address.countryCode = site.address.countryCode;
        return patch('srm', `/v1/sites/${site.siteCode}`, body);
      }
      return post('srm', `/v1/suppliers/${supplierCode}/sites`, body);
    },
  });
  if (ok) { toast(site ? 'Site saved' : `Site ${ok.siteCode} added`); refresh(ok); }
}

async function deleteSite(site, refresh) {
  const ok = await confirmModal({ sys: 'srm', title: `Delete site ${site.siteCode}?`, confirmLabel: 'Delete site', text: 'Existing TMS shipments keep their copy of the address.', onConfirm: () => del('srm', `/v1/sites/${site.siteCode}`) });
  if (ok) { toast('Site deleted'); refresh(); }
}

async function editContact(supplierCode, c, refresh) {
  const ok = await formModal({
    sys: 'srm', title: c ? `Edit contact ${c.contactId}` : 'Add contact', submitLabel: c ? 'Save contact' : 'Add contact',
    fields: [
      c || supplierCode ? null : { name: 'supplierCode', label: 'Supplier', type: 'select', required: true, options: () => cache.supplierOptions() },
      { name: 'name', label: 'Full name', required: !c, value: c && c.name },
      { name: 'role', label: 'Role', type: 'select', required: true, value: c ? c.role : 'PRIMARY', options: ROLES.map((v) => ({ value: v, label: label(v) })) },
      { name: 'email', label: 'Email', type: 'email', required: !c, value: c && c.email },
      { name: 'phone', label: 'Phone', value: c && c.phone },
    ].filter(Boolean),
    onSubmit: (v) => {
      if (c) {
        return patch('srm', `/v1/contacts/${c.contactId}`, compact({ name: v.name !== c.name ? v.name : undefined, role: v.role !== c.role ? v.role : undefined, email: v.email !== c.email ? v.email : undefined, phone: v.phone !== c.phone ? v.phone : undefined }));
      }
      return post('srm', `/v1/suppliers/${supplierCode || v.supplierCode}/contacts`, compact({ name: v.name, role: v.role, email: v.email, phone: v.phone }));
    },
  });
  if (ok) { toast(c ? 'Contact saved' : `Contact ${ok.contactId} added`); refresh(ok); }
}

async function deleteContact(c, refresh) {
  const ok = await confirmModal({ sys: 'srm', title: `Delete ${c.name}?`, confirmLabel: 'Delete contact', text: `${c.contactId}, ${label(c.role).toLowerCase()} contact.`, onConfirm: () => del('srm', `/v1/contacts/${c.contactId}`) });
  if (ok) { toast('Contact deleted'); refresh(); }
}

// ═══ Sites ══════════════════════════════════════════════════════════════
const sitePage = {
  id: 'srm/sites',
  sys: 'srm',
  nav: 'Sites',
  title: 'Supplier sites',
  render(main, ctx) {
    return listPage(main, {
      id: this.id, sys: 'srm', paging: 'offset', pageSize: 25, presetFilters: ctx.query,
      lede: 'Ship-from, remit-to and manufacturing locations. The façade turns a ship-from site into the TMS shipment origin.',
      dialect: 'SRM: offset/limit, {total, offset, limit, items}',
      filters: [
        { name: 'supplierCode', label: 'Supplier', type: 'select', options: () => cache.supplierOptions() },
        { name: 'type', label: 'Type', type: 'select', options: SITE_TYPES.map((v) => ({ value: v, label: label(v) })) },
        { name: 'active', label: 'Active', type: 'select', options: [{ value: 'true', label: 'Active' }, { value: 'false', label: 'Inactive' }] },
      ],
      actions: [h('button', { type: 'button', class: 'btn primary', 'data-sys': 'srm', onclick: () => this.create(ctx) }, 'New site')],
      load: async ({ filters, offset, limit }) => {
        const r = await get('srm', '/v1/sites', { ...filters, offset, limit });
        return { rows: r.items, total: r.total };
      },
      rowKey: (r) => r.siteCode,
      onOpen: (r) => ctx.go(this.id, r.siteCode),
      columns: [
        { label: 'Site', render: (x) => h('span', { class: 'id' }, x.siteCode) },
        { label: 'Supplier', render: (x) => link('srm/suppliers', x.supplierCode, x.supplierCode, 'mono') },
        { label: 'Type', render: (x) => label(x.type) },
        { label: 'Name', render: (x) => h('span', null, x.name, h('span', { class: 'sub' }, [x.address.city, x.address.region].filter(Boolean).join(', '))) },
        { label: 'Country', render: (x) => x.address.countryCode },
        { label: 'Active', render: (x) => badge(String(x.active), x.active ? 'Active' : 'Inactive') },
      ],
    });
  },
  async create(ctx) {
    const sel = await formModal({
      sys: 'srm', title: 'New site', intro: 'Choose the supplier first.', submitLabel: 'Continue',
      fields: [{ name: 'supplierCode', label: 'Supplier', type: 'select', required: true, options: () => cache.supplierOptions() }],
      onSubmit: async (v) => v.supplierCode,
    });
    if (sel) editSite(sel, null, (created) => { ctx.go(this.id, created && created.siteCode, { reload: true }); });
  },
  async open(id, ctx) {
    let x;
    try {
      x = await get('srm', `/v1/sites/${encodeURIComponent(id)}`);
    } catch (err) {
      toast(errorText(err), 'error');
      return ctx.go(this.id);
    }
    const refresh = () => { ctx.reload(); this.open(id, ctx); };
    openDrawer({
      sys: 'srm', kicker: `${label(x.type)} site`, title: x.name, subtitle: h('span', { class: 'mono' }, x.siteCode),
      actions: [
        h('button', { type: 'button', class: 'btn small', onclick: () => editSite(x.supplierCode, x, refresh) }, 'Edit'),
        h('button', { type: 'button', class: 'btn small danger', onclick: () => deleteSite(x, () => { closeDrawer({ silent: true }); ctx.go(this.id, null, { reload: true }); }) }, 'Delete'),
      ],
      onClose: () => ctx.go(this.id),
      tabs: [
        {
          label: 'Details',
          render: () => kv([
            ['Supplier', link('srm/suppliers', x.supplierCode, x.supplierCode, 'mono')],
            ['Type', label(x.type)],
            ['Address', [x.address.line1, x.address.city, x.address.region, x.address.postalCode, x.address.countryCode].filter(Boolean).join(', ')],
            ['Active', x.active ? 'Yes' : 'No'],
          ]),
        },
        rawTab('srm', x, `GET /srm/v1/sites/${x.siteCode}`),
      ],
    });
  },
};

// ═══ Contacts ═══════════════════════════════════════════════════════════
const contactPage = {
  id: 'srm/contacts',
  sys: 'srm',
  nav: 'Contacts',
  title: 'Supplier contacts',
  render(main, ctx) {
    return listPage(main, {
      id: this.id, sys: 'srm', paging: 'offset', pageSize: 25, presetFilters: ctx.query,
      lede: 'People at each supplier. The façade uses the primary contact on the supplier summary.',
      dialect: 'SRM: offset/limit, {total, offset, limit, items}',
      filters: [
        { name: 'q', label: 'Name or email', placeholder: 'kim' },
        { name: 'role', label: 'Role', type: 'select', options: ROLES.map((v) => ({ value: v, label: label(v) })) },
        { name: 'supplierCode', label: 'Supplier', type: 'select', options: () => cache.supplierOptions() },
      ],
      actions: [h('button', { type: 'button', class: 'btn primary', 'data-sys': 'srm', onclick: () => editContact(null, null, (c) => ctx.go(this.id, c && c.contactId, { reload: true })) }, 'New contact')],
      load: async ({ filters, offset, limit }) => {
        const r = await get('srm', '/v1/contacts', { ...filters, offset, limit });
        return { rows: r.items, total: r.total };
      },
      rowKey: (r) => r.contactId,
      onOpen: (r) => ctx.go(this.id, r.contactId),
      columns: [
        { label: 'Contact', render: (c) => h('span', null, c.name, h('span', { class: 'sub mono' }, c.contactId)) },
        { label: 'Supplier', render: (c) => link('srm/suppliers', c.supplierCode, c.supplierCode, 'mono') },
        { label: 'Role', render: (c) => label(c.role) },
        { label: 'Email', key: 'email' },
        { label: 'Phone', key: 'phone' },
      ],
    });
  },
  async open(id, ctx) {
    let c;
    try {
      c = await get('srm', `/v1/contacts/${encodeURIComponent(id)}`);
    } catch (err) {
      toast(errorText(err), 'error');
      return ctx.go(this.id);
    }
    const refresh = () => { ctx.reload(); this.open(id, ctx); };
    openDrawer({
      sys: 'srm', kicker: `${label(c.role)} contact`, title: c.name, subtitle: h('span', { class: 'mono' }, c.contactId),
      actions: [
        h('button', { type: 'button', class: 'btn small', onclick: () => editContact(c.supplierCode, c, refresh) }, 'Edit'),
        h('button', { type: 'button', class: 'btn small danger', onclick: () => deleteContact(c, () => { closeDrawer({ silent: true }); ctx.go(this.id, null, { reload: true }); }) }, 'Delete'),
      ],
      onClose: () => ctx.go(this.id),
      tabs: [
        { label: 'Details', render: () => kv([['Supplier', link('srm/suppliers', c.supplierCode, c.supplierCode, 'mono')], ['Email', c.email], ['Phone', c.phone]]) },
        rawTab('srm', c, `GET /srm/v1/contacts/${c.contactId}`),
      ],
    });
  },
};

// ═══ Entitlements ═══════════════════════════════════════════════════════
const entFields = (e = null) => [
  e ? null : { name: 'consumerId', label: 'Consumer ID', required: true, placeholder: 'acme-supplier-portal', help: 'Matches the API consumer identity the gateway passes to the façade' },
  { name: 'displayName', label: 'Display name', required: !e, value: e && e.displayName, wide: !e },
  { name: 'consumerType', label: 'Consumer type', type: 'select', required: true, value: e ? e.consumerType : 'supplier-partner', options: CONSUMER_TYPES },
  { name: 'active', label: 'Active', type: 'checkbox', value: e ? e.active : true },
  { name: 'scopes', label: 'Scopes', type: 'checks', required: true, options: SCOPES, value: e ? e.scopes : ['supplier-orders.read'] },
  { name: 'allSuppliers', label: 'All suppliers (*)', type: 'checkbox', value: e ? e.allSuppliers : false, wide: true },
  { name: 'suppliers', label: 'Suppliers', type: 'textarea', value: e ? e.suppliers.join(', ') : '', help: 'Comma separated supplier codes, ignored when "All suppliers" is ticked' },
  { name: 'costCenter', label: 'Cost center', value: e && e.costCenter },
  { name: 'contactEmail', label: 'Contact email', type: 'email', value: e && e.contactEmail },
].filter(Boolean);

function entBody(v, e) {
  const list = (v.suppliers || '').split(/[\s,]+/).map((x) => x.trim().toUpperCase()).filter(Boolean);
  return compact({
    consumerId: v.consumerId, displayName: v.displayName, consumerType: v.consumerType, active: v.active, scopes: v.scopes,
    allSuppliers: v.allSuppliers, suppliers: v.allSuppliers ? (e ? undefined : []) : list,
    costCenter: v.costCenter, contactEmail: v.contactEmail,
  });
}

const entPage = {
  id: 'srm/entitlements',
  sys: 'srm',
  nav: 'Entitlements',
  title: 'Consumer entitlements',
  render(main, ctx) {
    return listPage(main, {
      id: this.id, sys: 'srm', paging: 'none',
      lede: 'Which API consumer may read or write orders for which supplier. The façade asks SRM before serving data (data-level authorisation).',
      dialect: 'SRM: {total, items}',
      filters: [{ name: 'active', label: 'Active', type: 'select', options: [{ value: 'true', label: 'Active' }, { value: 'false', label: 'Inactive' }] }],
      actions: [h('button', { type: 'button', class: 'btn primary', 'data-sys': 'srm', onclick: () => this.create(ctx) }, 'New entitlement')],
      load: async ({ filters }) => ({ rows: (await get('srm', '/v1/entitlements', filters)).items }),
      rowKey: (r) => r.consumerId,
      onOpen: (r) => ctx.go(this.id, r.consumerId),
      columns: [
        { label: 'Consumer', render: (e) => h('span', null, e.displayName, h('span', { class: 'sub mono' }, e.consumerId)) },
        { label: 'Type', render: (e) => e.consumerType },
        { label: 'Suppliers', render: (e) => (e.allSuppliers ? h('strong', null, 'All') : e.suppliers.join(', ')) },
        { label: 'Scopes', render: (e) => e.scopes.map((x) => x.replace('supplier-orders.', '')).join(', ') },
        { label: 'Active', render: (e) => badge(String(e.active), e.active ? 'Active' : 'Inactive') },
      ],
    });
  },
  async create(ctx) {
    const ok = await formModal({ sys: 'srm', title: 'New consumer entitlement', fields: entFields(), submitLabel: 'Create entitlement', onSubmit: (v) => post('srm', '/v1/entitlements', entBody(v, null)) });
    if (ok) { toast(`Entitlement ${ok.consumerId} created`); ctx.go(this.id, ok.consumerId, { reload: true }); }
  },
  async open(id, ctx) {
    let e;
    try {
      e = await get('srm', `/v1/entitlements/${encodeURIComponent(id)}`);
    } catch (err) {
      toast(errorText(err), 'error');
      return ctx.go(this.id);
    }
    const refresh = () => { ctx.reload(); this.open(id, ctx); };
    const edit = async () => {
      const ok = await formModal({ sys: 'srm', title: `Edit ${e.consumerId}`, fields: entFields(e), submitLabel: 'Save entitlement', onSubmit: (v) => patch('srm', `/v1/entitlements/${e.consumerId}`, entBody(v, e)) });
      if (ok) { toast('Entitlement saved'); refresh(); }
    };
    const remove = async () => {
      const ok = await confirmModal({ sys: 'srm', title: `Delete ${e.consumerId}?`, confirmLabel: 'Delete entitlement', text: 'The consumer will get 404 CONSUMER_NOT_FOUND from the check endpoint, which the façade turns into 403.', onConfirm: () => del('srm', `/v1/entitlements/${e.consumerId}`) });
      if (ok) { toast('Entitlement deleted'); closeDrawer({ silent: true }); ctx.go(this.id, null, { reload: true }); }
    };
    const check = async () => {
      await formModal({
        sys: 'srm', title: `Check access for ${e.consumerId}`, submitLabel: 'Run check',
        intro: 'Calls GET /entitlements/{consumerId}/check exactly as the façade does. The result shows in a toast and in the wire log.',
        fields: [
          { name: 'scope', label: 'Scope', type: 'select', required: true, options: SCOPES },
          { name: 'supplierCode', label: 'Supplier', type: 'select', options: () => cache.supplierOptions(), emptyLabel: 'No supplier (scope only)' },
        ],
        onSubmit: async (v) => {
          const r = await get('srm', `/v1/entitlements/${e.consumerId}/check`, v);
          toast(`${r.allowed ? 'Allowed' : 'Denied'}: ${r.reason}`, r.allowed ? 'ok' : 'error');
          return r;
        },
      });
    };
    openDrawer({
      sys: 'srm', kicker: e.consumerType, title: e.displayName, subtitle: h('span', null, h('span', { class: 'mono' }, e.consumerId), ' ', badge(String(e.active), e.active ? 'Active' : 'Inactive')),
      actions: [
        h('button', { type: 'button', class: 'btn small primary', 'data-sys': 'srm', onclick: check }, 'Check access'),
        h('button', { type: 'button', class: 'btn small', onclick: edit }, 'Edit'),
        h('button', { type: 'button', class: 'btn small danger', onclick: remove }, 'Delete'),
      ],
      onClose: () => ctx.go(this.id),
      tabs: [
        {
          label: 'Details',
          render: async () => {
            const sups = e.allSuppliers ? [] : await cache.suppliers().catch(() => []);
            return h('div', null,
              kv([
                ['Scopes', e.scopes.join(', ')],
                ['Cost center', e.costCenter],
                ['Contact', e.contactEmail],
                ['Updated', fmtDateTime(e.updatedAt)],
              ]),
              h('section', null, h('h3', null, 'Suppliers'), e.allSuppliers ? h('p', null, 'Every supplier (wildcard *).') : h('div', { class: 'table-wrap standalone' }, table([
                { label: 'Supplier', render: (code) => link('srm/suppliers', code, code, 'id') },
                { label: 'Name', render: (code) => { const s = sups.find((x) => x.supplierCode === code); return s ? s.name.legal : 'Unknown'; } },
                { label: 'Status', render: (code) => { const s = sups.find((x) => x.supplierCode === code); return s ? badge(s.status, label(s.status)) : ''; } },
              ], e.suppliers))));
          },
        },
        rawTab('srm', e, `GET /srm/v1/entitlements/${e.consumerId}`),
      ],
    });
  },
};

export const pages = [supplierPage, sitePage, contactPage, entPage];
