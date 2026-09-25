import { h, jsonView, sysTag } from '../ui.js';

/** Hash link to another page (optionally opening a record, optionally with list filters). */
export function link(pageId, id, label, cls, query) {
  let href = `#/${pageId}`;
  if (id) href += `/${encodeURIComponent(id)}`;
  if (query) href += `?${new URLSearchParams(query).toString()}`;
  return h('a', { href, class: cls || null }, label);
}

/** A bordered box that shows data fetched from another system and the call used to get it. */
export function xrefBox(sys, title, via, content) {
  return h('div', { class: 'xref', 'data-sys': sys },
    h('div', { class: 'xref-head' }, sysTag(sys), title, via ? h('span', { class: 'via' }, via) : null),
    content);
}

const DIALECTS = {
  erp: 'ERP dialect: snake_case fields, 10-digit numbers, YYYYMMDD dates, SAP timestamps, quantities as strings, payload wrapped in {data}.',
  srm: 'SRM dialect: nested camelCase objects, ISO-8601 dates, SUP-xxxxxx supplier codes, no envelope for single records.',
  tms: 'TMS dialect: camelCase with SCAC carrier codes, milestone codes (PLN, TND, ITR, DLV, EXC, CXL) and quantity/weight objects.',
};

/** Tab that shows the untouched backend payload. */
export function rawTab(sys, data, call) {
  return {
    label: 'Wire JSON',
    render: () => h('div', null,
      h('p', { class: 'dialect-note' }, h('code', null, call)),
      h('p', { class: 'dialect-note' }, DIALECTS[sys]),
      jsonView(data)),
  };
}

export const dialectNote = (text) => h('p', { class: 'dialect-note' }, text);
