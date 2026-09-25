# CLAUDE.md

Guidance for AI assistants (Claude Code, Claude projects) and humans changing this repository.

## What this is

Three deliberately different mock backends (ERP, SRM, TMS) behind the *Supplier Order Collaboration
API* façade (spec: `Supplier_Order_Collaboration_OpenAPI_3_1.yaml` in the repo root; `openapi/` holds only the three backend specs),
which is implemented in Axway Amplify Fusion. The point is to make the iPaaS **orchestrate,
transform and aggregate** visibly. No backend may answer a façade request on its own, and the dialects must
stay different. All data is fictitious.

Keep the orchestration compact (v2.2): every façade operation is **one SRM check plus one or two ERP/TMS
calls**. ERP purchase orders embed items, `ship_to` and `purch_org_name`; the SRM check resolves supplier ↔
ERP vendor (`supplier`, `allowedVendors`); TMS accepts `carrier.carrierCode`. Don't reintroduce lookups the
façade must make just to fill a field; put the difficulty in dialect and transformation instead.

Stack: Node 20 + Express, PostgreSQL (schemas `erp`, `srm`, `tms`), auto-migrate and auto-seed on start.
`SERVICE_MODE=combined` (port 3000, paths `/erp`, `/srm`, `/tms`) or `separate` (3001/3002/3003).

## Backend dialects (do not converge them)

| | ERP `/erp/v1` | SRM `/srm/v1` | TMS `/tms/v1` |
|---|---|---|---|
| Naming | snake_case | nested camelCase | camelCase, nested quantities/weights |
| Keys | `po_number` 10 digits, `vendor_id` `0000710xxx`, `item_no` `"00010"` | `SUP-xxxxxx`, ERP vendor numbers | SCAC carriers (`UPSN`, also accepts `UPS`), `SHP-YYYYMMDD-NNNNN` |
| Status | `01 02 03 04 05 09` | `ACTIVE ON_HOLD BLOCKED` | milestones `PLN TND ITR DLV EXC CXL` |
| Dates | `YYYYMMDD`, timestamps `YYYYMMDDhhmmss`, decimals as strings | ISO-8601 | ISO-8601 |
| Paging | `{data, pagination}` page/limit | `{total, offset, limit, items}` | `{count, results, nextCursor}` |
| Errors | `{error:{code,message,details[],timestamp,correlation_id}}` | `{errors:[{code,message,field}], traceId}` | `{fault:{faultCode "tms.X",faultString,httpStatus,detail[{path,issue}],correlationId}}` |

Shared behaviour: optional per-backend API keys (`x-api-key`), `Idempotency-Key` on every POST,
`X-Correlation-Id` echoed, chaos headers `x-mock-status` / `x-mock-delay-ms` when `CHAOS_ENABLED=true`.
ERP uses `ETag: W/"<po>-r<revision>"` with `If-Match` (412). Deletes return 204, or 409 when the record is
still referenced (`PLANT_IN_USE`, `PURCH_ORG_IN_USE`, `PO_HAS_FOLLOW_ON_DOCUMENTS`,
`SUPPLIER_HAS_ENTITLEMENTS`, `CARRIER_IN_USE`, `SHIPMENT_NOT_DRAFT`, `FIELD_LOCKED`).

`docs/MAPPING.md` is the answer key for the façade: the calls per operation, field, code and status mappings,
recipes (including the ASN saga: SRM check → TMS create → ERP delivery, TMS cancel on failure), error
normalisation to RFC 7807, seed cheat-sheet. The Postman *Scenarios* folder mirrors those recipes.

## Where things are

- `src/services/<svc>/routes.js`: endpoints and business rules; `errors.js`: that backend's error dialect.
- `src/shared/`: auth, chaos, idempotency, correlation, validation (`Validator`), DB helpers.
- `src/db/schema/<svc>.sql`: DDL (idempotent). `src/data/*.json` + `seed.js`: seed data.
- `openapi/<svc>.yaml`: OpenAPI 3.0.3, served at `/<svc>/openapi.(yaml|json)` and `/<svc>/api-docs`.
- `public/dashboard/`: data dashboard (vanilla ES modules, no build). `js/api.js` client and wire log,
  `ui.js` DOM toolkit and forms, `list.js` list pages, `cache.js` lookups, `main.js` hash router,
  `views/{overview,erp,srm,tms,common}.js`.
- `postman/`: **generated** by `tools/build-postman.py`. `tools/`: checks, generators, dashboard stub.

## Rules for changes

1. **Keep everything in step.** A new or changed endpoint touches, in one change:
   - the route in `src/services/<svc>/routes.js`;
   - the spec in `openapi/<svc>.yaml`;
   - the Postman requests in `tools/build-postman.py`, then run `npm run build:postman`. The generator
     refuses to build unless every request has an example (GETs on seed data get one from the stub
     automatically; pass `example=` otherwise), and it writes descriptions and variable guards itself;
   - the dashboard view in `public/dashboard/js/views/`;
   - the README API table, and `docs/MAPPING.md` if the façade mapping is affected.
2. **Seed data is generated.** Edit `tools/seed/expand_seed.py` or `tools/seed/base/*.json`, then
   `npm run build:seed` and `npm run validate:seed`.
   - Never hand-edit `src/data/*.json` without re-validating.
   - Anchor records must stay unchanged: POs 4500123456–4500123468 and shipments 00088, 00107, 00121, 00188.
   - Seeded IDs stay below the runtime sequences: confirmations < 7100000101, deliveries < 180000201,
     shipment suffix < 00200. The seed "today" is 2026-09-24T12:00Z.
3. **Run `npm run check`** (seed consistency plus Postman coverage) before committing.
4. **Dashboard design:**
   - Colours: concrete ground `#e6ebe9`, ink `#16202a`, ERP `#34508f`, SRM `#18785a`, TMS `#b15e12`.
   - Fonts: Archivo for the UI, IBM Plex Mono for IDs and JSON.
   - Detail drawer tabs: Details / Across systems / Wire JSON. The wire log dock is the signature element.
   - Avoid middle-dot separators, all-caps labels and arrows on buttons. Write sentence-case copy that says
     what happens.
5. **Docs:** the README stays detailed (Codespaces and ngrok quick starts, configuration table, API tables,
   troubleshooting). Add an entry to `CHANGELOG.md` for every version.

## Verifying without a database

When Postgres or npm packages are unavailable (for example in a sandbox):
- `node --check` every JS file (copy dashboard modules to `.mjs` first);
- parse the OpenAPI YAML and check `$ref`s;
- `npm run check`, plus `python3 tools/build-postman.py` (fails on a request without an example);
- `npm run dashboard:stub`, then click through the dashboard in a browser or with Playwright.

State clearly what was and was not tested against the real server. Business rules (409/412/422 paths, sagas)
need a real run: `npm run dev` then `npm run postman` (Newman) and `npm run smoke -- --write`.

## Delivering changes

The owner prefers complete, copy-paste-ready files. For an incremental update, provide:
- a ZIP with only the changed and new files, plus a `CHANGES-vX.Y.md` listing them;
- the full project ZIP.
