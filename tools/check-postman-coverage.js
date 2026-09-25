#!/usr/bin/env node
'use strict';
/**
 * Fails if any OpenAPI operation in openapi/{erp,srm,tms}.yaml has no request in the Postman collection.
 *
 *   node tools/check-postman-coverage.js     # or: npm run check:postman
 */
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const root = path.join(__dirname, '..');
const coll = JSON.parse(fs.readFileSync(path.join(root, 'postman', 'mock-po-backends.postman_collection.json'), 'utf8'));
const requests = [];
(function walk(items) {
  for (const i of items) {
    if (i.item) walk(i.item);
    else {
      const svc = i.request.url.host[0].replace(/[{}]/g, '').replace('Url', '');
      requests.push({ svc, method: i.request.method, path: `/${i.request.url.path.join('/')}` });
    }
  }
})(coll.item);

let total = 0;
const missing = [];
for (const svc of ['erp', 'srm', 'tms']) {
  const spec = yaml.load(fs.readFileSync(path.join(root, 'openapi', `${svc}.yaml`), 'utf8'));
  for (const [p, ops] of Object.entries(spec.paths)) {
    const rx = new RegExp(`^${p.replace(/\{[^}]+\}/g, '[^/]+')}$`);
    for (const m of Object.keys(ops).filter((k) => ['get', 'post', 'put', 'patch', 'delete'].includes(k))) {
      total += 1;
      if (!requests.some((r) => r.svc === svc && r.method === m.toUpperCase() && rx.test(r.path))) missing.push(`${svc.toUpperCase()} ${m.toUpperCase()} ${p}`);
    }
  }
}
if (missing.length) {
  console.error(`Postman collection is missing ${missing.length} of ${total} operations:\n  - ${missing.join('\n  - ')}`);
  process.exit(1);
}
console.log(`Postman collection covers all ${total} operations (${requests.length} requests).`);
