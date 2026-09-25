# Changelog

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
