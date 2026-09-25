import { loadConfig, services, serverConfig, onLog, getLog, clearLog, saveOverrides, clearOverrides } from './api.js';
import { h, mount, $, jsonView, sysTag, closeDrawer, formModal, toast } from './ui.js';
import * as cache from './cache.js';
import { overviewPage } from './views/overview.js';
import { pages as erpPages } from './views/erp.js';
import { pages as srmPages } from './views/srm.js';
import { pages as tmsPages } from './views/tms.js';

const GROUPS = [
  { sys: 'erp', label: 'Purchasing', pages: erpPages },
  { sys: 'srm', label: 'Supplier master', pages: srmPages },
  { sys: 'tms', label: 'Logistics', pages: tmsPages },
];

let registry = {};
const current = { page: null, query: '', id: null, list: null };
let lastHandled = null;

// ── Routing ──────────────────────────────────────────────────────────────
// #/<system>/<page>[/<id>][?filter=value]   or   #/overview
function parse(hash) {
  const raw = (hash || '').replace(/^#\/?/, '');
  const [path, qs = ''] = raw.split('?');
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  if (!parts.length || parts[0] === 'overview') return { page: 'overview', id: null, qs };
  const page = `${parts[0]}/${parts[1] || ''}`;
  return { page: registry[page] ? page : 'overview', id: parts.slice(2).join('/') || null, qs };
}

function hashFor(pageId, id, qs) {
  return `#/${pageId}${id ? `/${encodeURIComponent(id)}` : ''}${qs ? `?${qs}` : ''}`;
}

const ctx = {
  go(pageId, id = null, { reload = false } = {}) {
    const target = hashFor(pageId, id);
    lastHandled = target;
    if (location.hash !== target) location.hash = target;
    navigate({ page: pageId, id, qs: '' }, { reload, explicit: true });
  },
  reload() {
    if (current.list && current.list.reload) current.list.reload();
  },
  query: {},
};

async function navigate(target, { reload = false, explicit = false } = {}) {
  const page = registry[target.page];
  const pageChanged = current.page !== target.page || (target.qs && target.qs !== current.query);
  if (pageChanged) {
    closeDrawer({ silent: true });
    current.page = target.page;
    current.query = target.qs;
    current.id = null;
    ctx.query = target.qs ? Object.fromEntries(new URLSearchParams(target.qs)) : null;
    renderNav();
    $('#page-title').textContent = page.title;
    document.title = `${page.title}, supplier order backends`;
    const main = $('#main');
    try {
      current.list = await page.render(main, ctx);
    } catch (err) {
      mount(main, h('div', { class: 'form-error' }, err.message));
    }
    $('.rail').classList.remove('open');
  } else if (reload) {
    ctx.reload();
  }
  if (target.id) {
    if (explicit || target.id !== current.id || !$('#drawer').classList.contains('open')) {
      current.id = target.id;
      page.open(target.id, ctx);
    }
  } else if (current.id) {
    current.id = null;
    closeDrawer({ silent: true });
  }
}

window.addEventListener('hashchange', () => {
  if (location.hash === lastHandled) return;
  lastHandled = location.hash;
  navigate(parse(location.hash));
});

// ── Navigation rail ──────────────────────────────────────────────────────
function renderNav() {
  const nav = $('#nav');
  const link = (p) => h('a', { class: `nav-link${p.sys ? '' : ' nav-top'}`, href: hashFor(p.id), 'aria-current': current.page === p.id ? 'page' : null }, p.nav);
  mount(nav,
    link(overviewPage),
    GROUPS.filter((g) => services[g.sys]).map((g) => h('div', { class: 'nav-group', 'data-sys': g.sys },
      h('div', { class: 'nav-sys' }, g.sys.toUpperCase(), h('small', null, g.label)),
      g.pages.map(link))));
}

// ── Health pills ─────────────────────────────────────────────────────────
async function checkHealth() {
  const box = $('#health');
  const pills = await Promise.all(Object.values(services).map(async (s) => {
    const started = performance.now();
    let up = false;
    try {
      const res = await fetch(`${s.baseUrl}/health`, { headers: { 'ngrok-skip-browser-warning': 'true' }, cache: 'no-store' });
      up = res.ok;
    } catch {
      up = false;
    }
    const ms = Math.round(performance.now() - started);
    return h('span', { class: `pill ${up ? 'up' : 'down'}`, title: `${s.title}\n${s.baseUrl}` },
      h('span', { class: 'dot' }), h('span', { class: 'sys-tag-text' }, s.name.toUpperCase()), up ? `${ms} ms` : 'unreachable');
  }));
  mount(box, pills);
}

// ── Wire log ─────────────────────────────────────────────────────────────
let logOpen = false;
let expanded = null;
function renderLog(log, latest) {
  $('#wirelog-count').textContent = `${log.length} call${log.length === 1 ? '' : 's'}`;
  if (latest) $('#wirelog-last').textContent = `${latest.svc.toUpperCase()} ${latest.method} ${latest.path} ${latest.status} ${latest.ms} ms`;
  if (!logOpen) return;
  const body = $('#wirelog-body');
  const rows = log.slice(0, 120).map((e) => {
    const good = typeof e.status === 'number' && e.status < 400;
    const row = h('button', { type: 'button', class: 'wl-row', 'aria-expanded': String(expanded === e.id), onclick: () => { expanded = expanded === e.id ? null : e.id; renderLog(getLog()); } },
      h('span', { class: 't' }, e.at.toTimeString().slice(0, 8)),
      sysTag(e.svc),
      h('span', null, e.method),
      h('span', { class: `st ${good ? 'good' : 'bad'}` }, String(e.status)),
      h('span', { class: 'path' }, e.path),
      h('span', { class: 'ms right' }, `${e.ms} ms`));
    if (expanded !== e.id) return row;
    return [row, h('div', { class: 'wl-detail' },
      h('div', null, h('h4', null, `Request ${e.method} ${e.url}`), h('pre', { class: 'json', style: { marginBottom: '.5rem' } }, Object.entries(e.headers || {}).map(([k, v]) => `${k}: ${v}`).join('\n')), e.request !== undefined ? jsonView(e.request) : h('p', { class: 'muted' }, 'No body')),
      h('div', null, h('h4', null, `Response ${e.status}`), jsonView(e.response)))];
  });
  mount(body,
    h('div', { style: { display: 'flex', justifyContent: 'space-between', padding: '.4rem 1.6rem', fontSize: '.8rem', color: '#9fb0aa' } },
      'Every call the dashboard made, newest first. Select one to see both payloads.',
      h('button', { type: 'button', class: 'link', onclick: () => { clearLog(); expanded = null; } }, 'Clear')),
    rows);
}

function setupLog() {
  const toggle = $('#wirelog-toggle');
  toggle.addEventListener('click', () => {
    logOpen = !logOpen;
    toggle.setAttribute('aria-expanded', String(logOpen));
    $('#wirelog-body').hidden = !logOpen;
    renderLog(getLog());
  });
  onLog((log, latest) => renderLog(log, latest));
}

// ── Settings ─────────────────────────────────────────────────────────────
async function openSettings() {
  const fields = Object.values(services).flatMap((s) => [
    { name: `${s.name}.baseUrl`, label: `${s.name.toUpperCase()} base URL`, value: s.baseUrl, required: true, help: s.defaults.baseUrl === s.baseUrl ? 'Server default' : `Server default: ${s.defaults.baseUrl}` },
    { name: `${s.name}.apiKey`, label: `${s.name.toUpperCase()} API key (${s.apiKeyHeader})`, value: s.apiKey, help: s.authMode === 'none' ? 'Auth is off for this backend' : 'Sent on every call' },
  ]);
  const saved = await formModal({
    sys: 'erp',
    title: 'Connection settings',
    intro: `Stored in this browser only. Server mode: ${serverConfig.mode}. Keys are pre-filled only while the server still uses the published demo keys.`,
    fields: [...fields, { name: 'reset', label: 'Reset everything to the server defaults', type: 'checkbox', wide: true }],
    submitLabel: 'Save settings',
    onSubmit: async (v) => {
      if (v.reset) {
        clearOverrides();
        return 'reset';
      }
      const out = {};
      for (const s of Object.values(services)) {
        out[s.name] = { baseUrl: v[`${s.name}.baseUrl`], apiKey: v[`${s.name}.apiKey`] || '', apiKeyHeader: s.apiKeyHeader };
      }
      saveOverrides(out);
      return 'saved';
    },
  });
  if (saved) {
    toast(saved === 'reset' ? 'Settings reset' : 'Settings saved');
    cache.invalidate();
    cache.clearXref();
    checkHealth();
    const target = parse(location.hash);
    current.page = null;
    navigate(target);
  }
}

// ── Boot ─────────────────────────────────────────────────────────────────
async function boot() {
  await loadConfig();
  registry = { [overviewPage.id]: overviewPage };
  for (const g of GROUPS) if (services[g.sys]) for (const p of g.pages) registry[p.id] = p;

  $('#open-settings').addEventListener('click', openSettings);
  $('#menu-btn').addEventListener('click', () => $('.rail').classList.toggle('open'));
  $('#scrim').addEventListener('click', () => closeDrawer());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && $('#drawer').classList.contains('open') && !$('#modal').open) closeDrawer();
  });
  setupLog();
  renderNav();
  checkHealth();
  setInterval(checkHealth, 30000);
  lastHandled = location.hash;
  navigate(parse(location.hash));
}

boot();
