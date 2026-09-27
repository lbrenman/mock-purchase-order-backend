# Changelog

## 2.4.0

The façade has its own folder, and a browser console for calling it.

- **New `facade/` folder.** The façade spec moved from the repository root to
  `facade/Supplier_Order_Collaboration_OpenAPI_3_1.yaml` (content unchanged by the move). Links in the README,
  `docs/MAPPING.md` and `CLAUDE.md` point to the new path.
- **Fusion-friendly status filters in the façade spec.** The `status` query parameters on `GET /purchase-orders`
  and `GET /shipments` are now strings holding a comma-separated list, checked by a pattern of the allowed values,
  with a description and an example, instead of arrays with `style: form, explode: false`. The wire format is the
  same. `docs/MAPPING.md` describes the filter accordingly.
- **New `facade/facade-console.html`.** A single-file web app for calling the façade in Fusion: a Settings tab
  (base address, key header, one API key or bearer token per consumer, kept in localStorage, with export and
  import), purchase-order and shipment lists and details, a *Calling as* consumer switcher, and an Activity log
  with correlation IDs and *Copy as cURL*.
- New `facade/README.md` (spec notes, opening the console, CORS the façade must allow, troubleshooting). README:
  *Façade console* section, notes on the status filters and duplicate-proxy import errors in *Using the specs in
  Amplify Fusion*, updated project structure. `CLAUDE.md`: `facade/` in *Where things are*.
- No change to the backends, seed data, Postman collection or dashboard.

## 2.3.0

Seed data no longer goes stale.

- **Dates follow the calendar.** New `src/data/date-shift.js`: when the seed is loaded, every date and
  timestamp moves forward by the time since the seed's "today" (2026-09-24), in whole weeks so weekdays are kept.
  Open orders stay open, in-transit shipments are still moving, nothing is dated in the future, and the three
  backends stay consistent. The JSON files are unchanged; IDs that contain a date keep it.
- New settings `SEED_SHIFT` (default `on`) and `SEED_TODAY` (shift towards a chosen day) in `.env.example`
  and the README configuration table.
- `src/data/seed.js` applies the shift and logs it; `tools/dashboard-stub.py` applies the same shift when it
  runs (not when `build-postman.py` imports it).
- `tools/validate-seed.js` fails if a date field is missing from the shift list, and checks that a copy
  shifted a year ahead moves every date by the same whole number of weeks.
- Postman: *List changed since (delta sync)* uses a new `{{changedSince}}` variable (ten days ago, set by the
  collection pre-request script) instead of a fixed timestamp. Collection regenerated.
- `scripts/smoke-test.js`: the ASN schedule is relative to now.
- README: *Dates stay current* section, updating an existing Codespace, demo-control examples without fixed
  dates, troubleshooting row. `docs/MAPPING.md` and `CLAUDE.md` notes.
- **After updating, run `npm run seed:reset` once** so an existing database gets current dates.

## 2.2.3

All references to the original customer are gone from the repository. "Acme" is the fictitious buying company.

- Seed data (`src/data/*.json`, `tools/seed/base/*.json`, `tools/seed/expand_seed.py`):
  - plant names such as `Acme Tampa Bay`;
  - buying organisations `Acme-US`, `Acme-CN`, ...;
  - purchasing-org codes `JBxx` → `AMxx` (`AMUS`, `AMCN`, ...);
  - consumer IDs `acme-ops-console`, `acme-procurement-workbench`, ...;
  - contact e-mails `@acme.example.com`.
- Façade spec `Supplier_Order_Collaboration_OpenAPI_3_1.yaml`:
  - title *Supplier Order Collaboration API*;
  - extensions `x-acme-*`;
  - neutral wording in the info block, license and security descriptions;
  - example site names. Paths and schemas are unchanged.
- Backend spec examples, Postman collection (regenerated), smoke test, dashboard copy, MAPPING.md, README,
  CLAUDE.md and the schema comment follow suit.
- **Existing databases keep the old rows.** Seeding never overwrites existing rows, so run
  `npm run seed:reset` once after updating.

## 2.2.2

- Added the façade (front-end) spec `Supplier_Order_Collaboration_OpenAPI_3_1.yaml` to the repository root, kept apart from
  the backend specs in `openapi/`. README, `docs/MAPPING.md` and `CLAUDE.md` link to it.

## 2.2.1

- **Postman:** new scenario *4. Create an ASN (POST /shipments)*, the happy path for one shipment covering two
  purchase orders (4500123456 line 10 and 4500123467 line 20): SRM check → TMS shipment → ERP inbound delivery,
  then clean-up. Each step's description has its field-mapping table; the ERP step's test script builds the
  façade 201 response from the TMS shipment and shows it in the Visualize tab and the console. The compensation
  scenario is now number 5 (later scenarios renumbered). 164 requests.
- **docs/MAPPING.md:** worked example for `POST /shipments` with the façade request, all three backend request
  bodies and the façade response.
- `.devcontainer/devcontainer.json`: only ports 3000 and 5432 are forwarded up front, so the Ports panel no
  longer lists 3001–3003 in combined mode (they are still labelled when separate mode opens them).

## 2.2.0

Simpler façade mapping: every façade operation is now one SRM call plus one or two ERP or TMS calls.

- **ERP:** every purchase order (list and detail) embeds `ship_to` (plant address) and `purch_org_name`, and
  the list always includes items. No `/plants`, `/reference/purchasing-orgs` or per-PO item calls are needed
  at runtime. `include=items` is still accepted and ignored.
- **SRM:** `GET|POST /entitlements/{consumerId}/check` accepts `erpVendorNumber` as an alternative to
  `supplierCode` and returns `supplier` (code, ERP vendor number, status, `asnEnabled`) and `allowedVendors`
  (code and ERP vendor number for every supplier the consumer may see). The façade no longer needs
  `/vendor-xref` or `/suppliers` calls.
- **TMS:** `POST` and `PATCH /shipments` accept `carrier.carrierCode` (`UPS`) as well as `carrier.scac`.
  A cancelled shipment frees its ASN number, so a saga can retry after compensating. The migration replaces
  the table-level unique constraint with a partial unique index (runs automatically on start).
- **docs/MAPPING.md** rewritten around the shorter recipes, with a one-table overview. The ASN saga is now
  SRM check → TMS create → ERP inbound delivery, compensating with a TMS cancel.
- **Postman:** 159 requests. Every request now has a saved example response (was 59 of 150), a description
  (expected status, required variables and the request that sets each one, saved variables) and a
  pre-request guard that stops with a clear message when a chained ID is still empty. Six scenario folders,
  one per façade operation, that clean up after themselves. Shipment dates are set by the collection-level
  pre-request script. New requests: SRM check by ERP vendor number, ERP façade-id 400, TMS unknown carrier
  code. `tools/build-postman.py` refuses to build if a request has no example.
- Dashboard: PO details show the embedded ship-to address and buying org without extra lookups; copy updated
  for the new saga order and carrier handling. Stub server returns the new shapes and implements the check.
- Smoke test follows the new recipes (including the saga retry with the same ASN) and no longer counts each
  failure twice.
- README: new overview of calls per façade operation, Postman section, API tables and examples; references
  to the original customer removed.
- OpenAPI specs: version 1.1.0.

## 2.1.0

- `tools/` with the helper scripts used to build the project:
  - `validate-seed.js` and `check-postman-coverage.js` (Node);
  - `build-postman.py`, `seed/expand_seed.py` and `dashboard-stub.py` (Python 3, standard library only).
- npm scripts `check`, `validate:seed`, `check:postman`, `build:seed`, `build:postman`, `dashboard:stub`.
- `CLAUDE.md` (conventions and change workflow), this changelog, and a README *Development tools* section.
- No API, data or dashboard behaviour changes. The generators reproduce the v2.0 seed and Postman files exactly.

## 2.0.0

- Seed data expanded to 23 suppliers, 74 POs, 54 confirmations, 34 inbound deliveries, 40 shipments and
  137 events, consistent across systems.
- Full CRUD maintenance endpoints on every entity, with 409 conflicts for referenced records. New endpoints:
  - ERP confirmation list;
  - SRM site and contact lists;
  - TMS shipment PATCH/DELETE and carrier filter.
- Data dashboard at `/dashboard/` with list and detail views, forms, cross-system tabs and the wire log.
  New settings: `DASHBOARD_ENABLED`, `DASHBOARD_PREFILL_DEMO_KEYS`, `<SVC>_PUBLIC_URL`.
- Postman collection (150 requests, all 74 operations, tests, examples, scenarios) and three environments;
  `npm run postman`.

## 1.0.0

- ERP, SRM and TMS mock backends with Postgres persistence, per-backend API keys, idempotency, correlation
  IDs and chaos controls.
- OpenAPI specs and Swagger UI; `docs/MAPPING.md`; Codespaces and ngrok support; smoke test.
