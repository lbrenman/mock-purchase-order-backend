import { h, mount, table, loadingTable, errorText, debounce } from './ui.js';

const states = new Map();

/**
 * Renders a filterable, paginated list.
 *  cfg = {
 *    id, sys, lede, paging: 'page' | 'offset' | 'cursor', pageSize,
 *    filters: [{ name, label, type: 'text'|'select', options, placeholder }],
 *    load: async ({ filters, page, offset, cursor, limit }) => ({ rows, total?, hasNext?, nextCursor? }),
 *    columns, rowKey, onOpen(row), actions: [Node], dialect: 'text shown next to the pager'
 *  }
 * Returns { reload() }.
 */
export function listPage(main, cfg) {
  const st = states.get(cfg.id) || { filters: { ...(cfg.defaults || {}) }, page: 1, offset: 0, cursors: [undefined] };
  states.set(cfg.id, st);
  if (cfg.presetFilters) {
    st.filters = { ...st.filters, ...cfg.presetFilters };
    st.page = 1;
    st.offset = 0;
    st.cursors = [undefined];
  }
  const limit = cfg.pageSize || 25;
  const tableWrap = h('div', { class: 'table-wrap' }, loadingTable(cfg.columns.length));
  const pager = h('div', { class: 'pager' });

  const resetPaging = () => {
    st.page = 1;
    st.offset = 0;
    st.cursors = [undefined];
  };
  const onFilter = debounce(() => {
    resetPaging();
    reload();
  }, 350);

  const filterEls = (cfg.filters || []).map((f) => {
    let input;
    if (f.type === 'select') {
      input = h('select', { name: f.name, onchange: (e) => { st.filters[f.name] = e.target.value; onFilter(); } },
        h('option', { value: '' }, f.all || 'All'));
      const fill = (opts) => opts.forEach((o) => {
        const opt = typeof o === 'object' ? o : { value: o, label: o };
        input.append(h('option', { value: opt.value, selected: String(st.filters[f.name] ?? '') === String(opt.value) }, opt.label));
      });
      if (typeof f.options === 'function') Promise.resolve(f.options()).then(fill).catch(() => {});
      else fill(f.options || []);
    } else {
      input = h('input', { type: 'search', name: f.name, value: st.filters[f.name] || '', placeholder: f.placeholder || '',
        oninput: (e) => { st.filters[f.name] = e.target.value.trim(); onFilter(); } });
    }
    return h('label', null, f.label, input);
  });

  const toolbar = h('div', { class: 'toolbar', style: { '--sys-color': `var(--${cfg.sys})` } },
    filterEls,
    h('span', { class: 'grow' }),
    h('button', { type: 'button', class: 'btn', onclick: () => reload() }, 'Refresh'),
    cfg.actions || []);

  mount(main,
    cfg.lede ? h('div', { class: 'page-head' }, h('p', { class: 'lede' }, cfg.lede)) : null,
    toolbar, tableWrap, pager);

  let ticket = 0;
  async function reload() {
    const my = ++ticket;
    mount(tableWrap, loadingTable(cfg.columns.length));
    const args = { filters: { ...st.filters }, limit };
    if (cfg.paging === 'page') args.page = st.page;
    if (cfg.paging === 'offset') args.offset = st.offset;
    if (cfg.paging === 'cursor') args.cursor = st.cursors[st.cursors.length - 1];
    try {
      const res = await cfg.load(args);
      if (my !== ticket) return;
      mount(tableWrap, table(cfg.columns, res.rows, { onRowClick: cfg.onOpen, rowKey: cfg.rowKey, empty: cfg.empty }));
      renderPager(res);
    } catch (err) {
      if (my !== ticket) return;
      mount(tableWrap, h('div', { class: 'empty' }, h('strong', null, 'Could not load this list'), errorText(err)));
      mount(pager);
    }
  }

  function renderPager(res) {
    const prev = h('button', { type: 'button', class: 'btn small' }, 'Previous');
    const next = h('button', { type: 'button', class: 'btn small' }, 'Next');
    let info = '';
    if (cfg.paging === 'page') {
      const pages = Math.max(1, Math.ceil((res.total || 0) / limit));
      info = `${res.total} record${res.total === 1 ? "" : "s"}, page ${st.page} of ${pages}`;
      prev.disabled = st.page <= 1;
      next.disabled = !res.hasNext;
      prev.onclick = () => { st.page -= 1; reload(); };
      next.onclick = () => { st.page += 1; reload(); };
    } else if (cfg.paging === 'offset') {
      const from = res.total ? st.offset + 1 : 0;
      info = `${from}–${st.offset + res.rows.length} of ${res.total}`;
      prev.disabled = st.offset <= 0;
      next.disabled = st.offset + res.rows.length >= res.total;
      prev.onclick = () => { st.offset = Math.max(0, st.offset - limit); reload(); };
      next.onclick = () => { st.offset += limit; reload(); };
    } else if (cfg.paging === 'none') {
      mount(pager, h('span', null, `${res.rows.length} record${res.rows.length === 1 ? '' : 's'}`), h('span', { class: 'spacer' }),
        cfg.dialect ? h('span', { class: 'dialect' }, cfg.dialect) : null);
      return;
    } else {
      info = `${res.rows.length} on this page${res.nextCursor ? ', more available' : ''}`;
      prev.disabled = st.cursors.length <= 1;
      next.disabled = !res.nextCursor;
      prev.onclick = () => { st.cursors.pop(); reload(); };
      next.onclick = () => { st.cursors.push(res.nextCursor); reload(); };
    }
    mount(pager, h('span', null, info), h('span', { class: 'spacer' }), cfg.dialect ? h('span', { class: 'dialect' }, cfg.dialect) : null, prev, next);
  }

  reload();
  return { reload };
}
