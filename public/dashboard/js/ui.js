// Small DOM toolkit: no framework, no build step.

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') {
        for (const [prop, val] of Object.entries(v)) {
          if (prop.startsWith('--')) el.style.setProperty(prop, val);
          else el.style[prop] = val;
        }
      }
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'html') el.innerHTML = v;
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === undefined || c === null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export const clear = (el) => {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
};
export const mount = (el, ...children) => {
  clear(el);
  append(el, children);
  return el;
};
export const $ = (sel, root = document) => root.querySelector(sel);

// ── Formatting ───────────────────────────────────────────────────────────
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Accepts YYYYMMDD, YYYY-MM-DD, YYYYMMDDhhmmss or ISO; returns a Date (UTC) or null. */
export function parseAny(v) {
  if (!v) return null;
  const s = String(v);
  let m = s.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
  m = s.match(/^(\d{4})-?(\d{2})-?(\d{2})$/);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}
export function fmtDate(v) {
  const d = parseAny(v);
  return d ? `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}` : '—';
}
export function fmtDateTime(v) {
  const d = parseAny(v);
  if (!d) return '—';
  const p = (n) => String(n).padStart(2, '0');
  return `${fmtDate(d.toISOString())}, ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
}
export function relative(v) {
  const d = parseAny(v);
  if (!d) return '';
  const diff = (d.getTime() - Date.now()) / 86400000;
  const n = Math.round(Math.abs(diff));
  if (n === 0) return 'today';
  let span = `${n} day${n === 1 ? '' : 's'}`;
  if (n >= 730) span = `${Math.floor(n / 365)} years`;
  else if (n >= 60) span = `${Math.floor(n / 30)} months`;
  return diff > 0 ? `in ${span}` : `${span} ago`;
}
export const isoDate = (v) => {
  const d = parseAny(v);
  return d ? d.toISOString().slice(0, 10) : '';
};
export const sapDate = (v) => (v ? String(v).replace(/-/g, '') : undefined);
export function toLocalInput(v) {
  const d = parseAny(v);
  if (!d) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}
/** datetime-local inputs are treated as UTC to keep the demo timezone-neutral. */
export const fromLocalInput = (v) => (v ? `${v}:00Z` : undefined);

export function num(v, digits) {
  if (v === null || v === undefined || v === '') return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  return n.toLocaleString('en-US', { minimumFractionDigits: digits ?? 0, maximumFractionDigits: digits ?? 3 });
}
export function money(v, ccy) {
  if (v === null || v === undefined) return '—';
  return `${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${ccy || ''}`.trim();
}

// ── Status badges ────────────────────────────────────────────────────────
const TONES = {
  // ERP PO status codes
  '01': 'b-open', '02': 'b-progress', '03': 'b-good', '04': 'b-move', '05': 'b-done', '09': 'b-bad',
  // SRM
  ACTIVE: 'b-good', ON_HOLD: 'b-progress', BLOCKED: 'b-bad',
  // TMS milestones
  PLN: 'b-draft', TND: 'b-open', ITR: 'b-move', DLV: 'b-good', EXC: 'b-bad', CXL: 'b-done',
  // documents
  POSTED: 'b-good', IN_REVIEW: 'b-progress', REVERSED: 'b-done', AB: 'b-good', AC: 'b-progress', RJ: 'b-bad',
  true: 'b-good', false: 'b-done',
};
export function badge(code, text) {
  const c = String(code);
  const same = text && c.toLowerCase().replace(/_/g, ' ') === String(text).toLowerCase();
  const showCode = text && !same && c !== 'true' && c !== 'false';
  return h('span', { class: `badge ${TONES[c] || ''}` }, showCode ? [h('span', { class: 'code' }, c), text] : text || c);
}
export const sysTag = (svc) => h('span', { class: `sys-tag ${svc}` }, svc.toUpperCase());

// ── Toasts ───────────────────────────────────────────────────────────────
export function toast(message, kind = 'ok') {
  const el = h('div', { class: `toast ${kind === 'error' ? 'error' : ''}`, role: kind === 'error' ? 'alert' : 'status' }, message);
  $('#toasts').append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 7000 : 3500);
}

export function errorText(err) {
  if (!err) return 'Something went wrong';
  const code = err.code ? `${err.code}: ` : '';
  return `${code}${err.message}`;
}

// ── JSON viewer ──────────────────────────────────────────────────────────
export function jsonView(value) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const src = esc(JSON.stringify(value, null, 2) ?? 'null');
  const html = src.replace(/("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g, (m, str, colon, bool, n) => {
    if (str) return colon ? `<span class="k">${str}</span>${colon}` : `<span class="s">${str}</span>`;
    if (bool) return `<span class="b">${bool}</span>`;
    return `<span class="n">${n}</span>`;
  });
  return h('pre', { class: 'json', html });
}

// ── Table ────────────────────────────────────────────────────────────────
/**
 * columns: [{ label, render(row) | key, class, num }]
 * opts: { onRowClick(row), rowKey(row), selectedKey, empty: {title, text} }
 */
export function table(columns, rows, opts = {}) {
  const thead = h('thead', null, h('tr', null, columns.map((c) => h('th', { class: c.num ? 'num' : c.class, scope: 'col' }, c.label))));
  const body = h('tbody');
  if (!rows.length) {
    body.append(h('tr', null, h('td', { colspan: columns.length }, h('div', { class: 'empty' },
      h('strong', null, (opts.empty && opts.empty.title) || 'Nothing here yet'),
      (opts.empty && opts.empty.text) || 'Try clearing the filters.'))));
  }
  for (const row of rows) {
    const key = opts.rowKey ? opts.rowKey(row) : null;
    const tr = h('tr', {
      class: [opts.onRowClick ? 'clickable' : '', key && key === opts.selectedKey ? 'selected' : ''].join(' ').trim() || null,
      tabindex: opts.onRowClick ? '0' : null,
    });
    if (opts.onRowClick) {
      tr.addEventListener('click', (e) => {
        if (e.target.closest('button, a, input')) return;
        opts.onRowClick(row);
      });
      tr.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') opts.onRowClick(row);
      });
    }
    for (const c of columns) {
      const v = c.render ? c.render(row) : row[c.key];
      tr.append(h('td', { class: c.num ? 'num' : c.class }, v === undefined || v === null || v === '' ? '—' : v));
    }
    body.append(tr);
  }
  return h('table', { class: 'data' }, thead, body);
}

export const loadingTable = (cols = 4, text = 'Loading…') =>
  h('table', { class: 'data' }, h('tbody', null, h('tr', { class: 'loading-row' }, h('td', { colspan: cols }, h('span', { class: 'spinner' }), ' ', text))));

export function kv(pairs) {
  const dl = h('dl', { class: 'kv' });
  for (const [k, v] of pairs) {
    if (v === undefined) continue;
    dl.append(h('dt', null, k), h('dd', null, v === null || v === '' ? '—' : v));
  }
  return dl;
}

// ── Drawer ───────────────────────────────────────────────────────────────
let drawerClose = null;
export function openDrawer({ sys, kicker, title, subtitle, actions = [], tabs, onClose }) {
  const drawer = $('#drawer');
  const scrim = $('#scrim');
  drawer.style.setProperty('--sys-color', `var(--${sys})`);
  const body = h('div', { class: 'drawer-body' });
  const tabBar = h('div', { class: 'tabs', role: 'tablist' });
  const select = (i) => {
    [...tabBar.children].forEach((b, j) => b.setAttribute('aria-selected', String(i === j)));
    mount(body, h('div', { class: 'stack' }, h('span', { class: 'spinner' })));
    Promise.resolve(tabs[i].render())
      .then((content) => mount(body, content))
      .catch((err) => mount(body, h('div', { class: 'form-error' }, errorText(err))));
  };
  tabs.forEach((t, i) => tabBar.append(h('button', { type: 'button', class: 'tab', role: 'tab', 'aria-selected': 'false', onclick: () => select(i) }, t.label)));
  mount(
    drawer,
    h('div', { class: 'drawer-head' },
      h('div', { class: 'kicker' }, sysTag(sys), kicker),
      h('h2', null, title),
      subtitle ? h('div', { class: 'subtitle' }, subtitle) : null,
      actions.length ? h('div', { class: 'drawer-actions' }, actions) : null,
      h('button', { type: 'button', class: 'btn small drawer-close', onclick: () => closeDrawer(), 'aria-label': 'Close details' }, 'Close')),
    tabBar,
    body
  );
  drawer.classList.add('open');
  drawer.setAttribute('aria-hidden', 'false');
  scrim.hidden = false;
  drawerClose = onClose || null;
  select(0);
  drawer.focus();
}

export function closeDrawer({ silent = false } = {}) {
  const drawer = $('#drawer');
  if (!drawer.classList.contains('open')) return;
  drawer.classList.remove('open');
  drawer.setAttribute('aria-hidden', 'true');
  $('#scrim').hidden = true;
  const fn = drawerClose;
  drawerClose = null;
  if (fn && !silent) fn();
}

// ── Modal forms ──────────────────────────────────────────────────────────
/**
 * field: { name, label, type: text|number|date|datetime|select|checkbox|textarea|checks|email|lines,
 *          required, options:[{value,label}] | async () => options, value, help, wide, placeholder, min, step,
 *          columns (lines): [{name,label,type,options,required,step}] }
 * Resolves the submit handler's return value, or undefined if cancelled.
 */
export function formModal({ sys = 'erp', title, intro, fields, submitLabel = 'Save', onSubmit }) {
  const dlg = $('#modal');
  return new Promise((resolve) => {
    const errBox = h('div', { class: 'form-error', hidden: true });
    const controls = {};
    const body = h('div', { class: 'modal-body' }, errBox);
    for (const f of fields) body.append(renderField(f, controls));
    const submit = h('button', { type: 'submit', class: 'btn primary', 'data-sys': sys }, submitLabel);
    const cancel = h('button', { type: 'button', class: 'btn', onclick: () => finish(undefined) }, 'Cancel');
    const form = h('form', { novalidate: true },
      h('div', { class: 'modal-head' }, h('h2', null, title), intro ? h('p', null, intro) : null),
      body,
      h('div', { class: 'modal-foot' }, cancel, submit));
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      dlg.close();
      resolve(v);
    };
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      errBox.hidden = true;
      const values = collect(fields, controls);
      const missing = fields.filter((f) => f.required && f.type !== 'lines' && (values[f.name] === undefined || values[f.name] === '' || (Array.isArray(values[f.name]) && !values[f.name].length)));
      if (missing.length) {
        mount(errBox, `Fill in: ${missing.map((f) => f.label).join(', ')}`);
        errBox.hidden = false;
        return;
      }
      submit.disabled = true;
      mount(submit, h('span', { class: 'spinner' }), ' Saving…');
      try {
        const result = await onSubmit(values);
        finish(result === undefined ? true : result);
      } catch (err) {
        mount(errBox, h('strong', null, errorText(err)),
          err.details && err.details.length ? h('ul', null, err.details.map((d) => h('li', null, h('code', null, d.field), ' ', d.message))) : null);
        errBox.hidden = false;
        errBox.scrollIntoView({ block: 'nearest' });
        submit.disabled = false;
        mount(submit, submitLabel);
      }
    });
    dlg.onclose = () => finish(undefined);
    dlg.style.setProperty('--sys-color', `var(--${sys})`);
    mount(dlg, form);
    dlg.showModal();
    const first = form.querySelector('input:not([type=checkbox]):not([disabled]), select, textarea');
    if (first) first.focus();
  });
}

function inputFor(f, value) {
  const common = { name: f.name, required: f.required, placeholder: f.placeholder, disabled: f.disabled };
  switch (f.type) {
    case 'select': {
      const sel = h('select', common, f.required ? null : h('option', { value: '' }, f.emptyLabel || '—'));
      const fill = (opts) => {
        for (const o of opts) {
          const opt = typeof o === 'object' ? o : { value: o, label: o };
          sel.append(h('option', { value: opt.value, selected: String(opt.value) === String(value ?? '') }, opt.label));
        }
        if (f.onChange) setTimeout(() => f.onChange(sel.value, sel, sel._controls), 0);
      };
      if (typeof f.options === 'function') {
        sel.append(h('option', { value: '', disabled: true }, 'Loading…'));
        Promise.resolve(f.options()).then((opts) => {
          [...sel.options].filter((o) => o.disabled && o.textContent === 'Loading…').forEach((o) => o.remove());
          fill(opts);
        });
      } else fill(f.options || []);
      if (f.onChange) sel.addEventListener('change', () => f.onChange(sel.value, sel, sel._controls));
      return sel;
    }
    case 'textarea':
      return h('textarea', { ...common, rows: 3 }, value ?? '');
    case 'checkbox':
      return h('input', { ...common, type: 'checkbox', checked: Boolean(value) });
    case 'number':
      return h('input', { ...common, type: 'number', step: f.step || 'any', min: f.min, value: value ?? '' });
    case 'date':
      return h('input', { ...common, type: 'date', value: value ? isoDate(value) : '' });
    case 'datetime':
      return h('input', { ...common, type: 'datetime-local', value: value ? toLocalInput(value) : '' });
    default:
      return h('input', { ...common, type: f.type === 'email' ? 'email' : 'text', value: value ?? '', maxlength: f.max });
  }
}

function renderField(f, controls) {
  if (f.type === 'lines') return renderLines(f, controls);
  if (f.type === 'checks') {
    const boxes = (f.options || []).map((o) => {
      const opt = typeof o === 'object' ? o : { value: o, label: o };
      return h('label', null, h('input', { type: 'checkbox', value: opt.value, checked: (f.value || []).includes(opt.value) }), opt.label);
    });
    const wrap = h('div', { class: 'checks' }, boxes);
    controls[f.name] = wrap;
    return h('div', { class: `field ${f.wide !== false ? 'wide' : ''}` }, h('span', null, f.label, f.required ? h('span', { class: 'req' }, ' *') : null), wrap, f.help ? h('span', { class: 'help' }, f.help) : null);
  }
  const input = inputFor(f, f.value);
  input._controls = controls;
  controls[f.name] = input;
  if (f.type === 'checkbox') {
    return h('label', { class: `field check ${f.wide ? 'wide' : ''}` }, input, h('span', null, f.label), f.help ? h('span', { class: 'help' }, f.help) : null);
  }
  return h('label', { class: `field ${f.wide || f.type === 'textarea' ? 'wide' : ''}` },
    h('span', null, f.label, f.required ? h('span', { class: 'req' }, ' *') : null), input, f.help ? h('span', { class: 'help' }, f.help) : null);
}

function renderLines(f, controls) {
  const rows = [];
  const set = h('fieldset', { class: 'lines' }, h('legend', null, f.label));
  const list = h('div');
  const addBtn = f.fixed ? null : h('button', { type: 'button', class: 'btn small', onclick: () => addRow({}) }, f.addLabel || 'Add line');
  const addRow = (val) => {
    const cells = {};
    const row = h('div', { class: 'line-row', style: { '--cols': String(f.columns.length) } });
    for (const c of f.columns) {
      const input = inputFor(c, val[c.name]);
      if (c.readonly) input.readOnly = true;
      cells[c.name] = input;
      row.append(h('label', null, c.label, input));
    }
    const rec = { row, cells };
    row.append(f.fixed ? h('span') : h('button', {
      type: 'button', class: 'btn small danger', 'aria-label': 'Remove line',
      onclick: () => {
        rows.splice(rows.indexOf(rec), 1);
        row.remove();
      },
    }, 'Remove'));
    rows.push(rec);
    list.append(row);
  };
  (Array.isArray(f.value) ? f.value : f.fixed ? [] : [{}]).forEach(addRow);
  set.append(list);
  if (addBtn) set.append(h('div', { style: { marginTop: '.5rem' } }, addBtn));
  if (f.help) set.append(h('div', { class: 'help muted', style: { fontSize: '.78rem', marginTop: '.4rem' } }, f.help));
  controls[f.name] = { lines: rows, columns: f.columns };
  return set;
}

function readInput(f, el) {
  if (f.type === 'checkbox') return el.checked;
  const v = el.value.trim();
  if (v === '') return undefined;
  if (f.type === 'number') return Number(v);
  if (f.type === 'datetime') return fromLocalInput(v);
  return v;
}

function collect(fields, controls) {
  const out = {};
  for (const f of fields) {
    const c = controls[f.name];
    if (f.type === 'lines') {
      out[f.name] = c.lines.map(({ cells }) => {
        const o = {};
        for (const col of c.columns) o[col.name] = readInput(col, cells[col.name]);
        return o;
      });
    } else if (f.type === 'checks') {
      out[f.name] = [...c.querySelectorAll('input:checked')].map((i) => i.value);
    } else out[f.name] = readInput(f, c);
  }
  return out;
}

export function confirmModal({ sys = 'erp', title, text, confirmLabel = 'Confirm', onConfirm }) {
  return formModal({ sys, title, intro: text, fields: [], submitLabel: confirmLabel, onSubmit: async () => (onConfirm ? onConfirm() : true) });
}

/** Drops undefined values (and empty objects) so PATCH bodies only carry what changed. */
export function compact(obj) {
  if (Array.isArray(obj)) return obj.map(compact);
  if (!obj || typeof obj !== 'object') return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    const c = compact(v);
    if (c && typeof c === 'object' && !Array.isArray(c) && !Object.keys(c).length) continue;
    out[k] = c;
  }
  return out;
}

export const debounce = (fn, ms = 300) => {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
};

/** Replaces the options of a <select> created by formModal (used for dependent fields). */
export function setOptions(sel, opts, { value, emptyLabel } = {}) {
  clear(sel);
  if (emptyLabel !== undefined) sel.append(h('option', { value: '' }, emptyLabel));
  for (const o of opts) {
    const opt = typeof o === 'object' ? o : { value: o, label: o };
    sel.append(h('option', { value: opt.value, selected: value !== undefined && String(value) === String(opt.value) }, opt.label));
  }
}
