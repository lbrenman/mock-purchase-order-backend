# Mock Purchase Order Backends (ERP · SRM · TMS)

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/lbrenman/mock-purchase-order-backend)

Three **independent, deliberately different** mock systems of record — built with Node.js/Express and
PostgreSQL — that sit behind the **Jabil Supplier Order Collaboration API**
(`Jabil_Supplier_Order_Collaboration_OpenAPI_3.1.yaml`) implemented in **Axway Amplify Fusion**.

The backends are *not* a proxy target for the façade. Each one owns a different slice of the data,
speaks its own dialect (naming, identifiers, dates, status codes, pagination, error format), and none of
them can answer a façade request on its own. That's the point: the iPaaS has to **orchestrate,
transform and aggregate** — visibly.

```mermaid
flowchart LR
    C[Supplier portal / internal app] -->|Supplier Order Collaboration API<br/>PO-4500123456 · SUP-100245 · ProblemDetails| F[Amplify Fusion<br/>integration]
    F -->|entitlements · supplier · sites · vendor xref| SRM[(SRM<br/>/srm/v1)]
    F -->|POs · items · confirmations · inbound deliveries · plants| ERP[(ERP<br/>/erp/v1)]
    F -->|ASNs · carriers · milestones · tracking| TMS[(TMS<br/>/tms/v1)]
```

| Backend | Path | Plays the role of | Dialect highlights |
|---|---|---|---|
| **ERP** | `/erp` | SAP-style purchasing system | `po_number` 10 digits (no `PO-`), `vendor_id` `0000710245`, `item_no` `"00010"`, status `01…09`, dates `YYYYMMDD`, decimals as strings, `{data, pagination}` page/limit, plant & purchasing-org codes |
| **SRM** | `/srm` | Supplier master / supplier relationship mgmt | nested camelCase, owns `SUP-xxxxxx`, **ERP vendor cross-reference**, supplier sites, **consumer entitlements** (who may see/act for which supplier), offset paging |
| **TMS** | `/tms` | Transportation management system | carriers by **SCAC** (`UPSN` not `UPS`), milestones `PLN/TND/ITR/DLV/EXC/CXL`, nested quantities/weights, **cursor** paging, SOAP-fault-style errors |

➡️ **[docs/MAPPING.md](docs/MAPPING.md)** is the answer key: every field, code and status mapping plus
step-by-step orchestration recipes (including saga compensation) for each façade operation.

---

## Contents

- [Features](#features)
- [Quick start — GitHub Codespaces](#quick-start--github-codespaces)
- [Quick start — local machine + ngrok](#quick-start--local-machine--ngrok)
- [Other ways to run](#other-ways-to-run)
- [Configuration](#configuration)
- [Authentication](#authentication)
- [API reference](#api-reference)
- [Façade coverage](#façade-coverage)
- [Demo controls (chaos, latency, state changes)](#demo-controls)
- [Using the specs in Amplify Fusion](#using-the-specs-in-amplify-fusion)
- [Project structure](#project-structure)
- [Troubleshooting](#troubleshooting)

---

## Features

- **3 backends, 1 process (or 3)** — `SERVICE_MODE=combined` serves `/erp`, `/srm`, `/tms` on one port
  (one ngrok tunnel / one Codespaces port). `SERVICE_MODE=separate` gives each its own port (3001/3002/3003).
- **PostgreSQL persistence** — one database, three schemas (`erp`, `srm`, `tms`), or point each backend at
  its own database. Tables are created and demo data is seeded **automatically on first start**.
- **OpenAPI 3.0 spec per backend** at `/<svc>/openapi.json` and `/<svc>/openapi.yaml`, Swagger UI at
  `/<svc>/api-docs`. The spec's `servers` URL is rewritten to the public URL (ngrok / Codespaces aware).
- **Optional API key security**, per backend (different key per system), switchable with `AUTH_MODE=none`.
- **Real business rules** the façade depends on: over-shipment (422), duplicate acknowledgement per PO
  revision (409), locked POs, supplier scope (403 via SRM), duplicate ASN, unknown carrier, stale revision
  (412 `If-Match`), plus **compensation endpoints** for saga demos.
- **Idempotency-Key** support on every POST (safe retries; replays flagged with `Idempotent-Replayed: true`).
- **X-Correlation-Id** accepted/generated and echoed in headers and errors (end-to-end tracing).
- **Chaos & latency controls** to show retries, timeouts, parallel fan-out and circuit breaking.
- Consistent seed data across the three systems (the same PO/supplier/shipment IDs line up everywhere).

---

## Quick start — GitHub Codespaces

1. Click **Open in GitHub Codespaces** above (or *Code → Codespaces → Create codespace* on the repo).
2. Wait for the container to build. It runs `npm install`, copies `.env.example` → `.env`, and starts
   Postgres in Docker (`scripts/start-postgres.sh`) automatically.
3. Start the API:
   ```bash
   npm run dev
   ```
   On first start you'll see `[migrate] … schema ready` and `[seed] … seeded`.
4. Open the **Ports** tab, right-click port **3000 → Port Visibility → Public**.
   *(Required so Amplify Fusion can reach it; private ports redirect to a GitHub login page.)*
5. Your base URL is `https://<codespace-name>-3000.app.github.dev`. Try:
   - `https://<codespace-name>-3000.app.github.dev/` — landing page with links
   - `…/erp/api-docs`, `…/srm/api-docs`, `…/tms/api-docs` — Swagger UI
   - `…/health` — aggregate health (no auth)

   ```bash
   curl -H "x-api-key: erp-demo-key" \
     "https://<codespace-name>-3000.app.github.dev/erp/v1/purchase-orders/4500123456"
   ```
6. Optional: `npm run smoke` runs a walkthrough of the aggregation flow against localhost.

> If the Codespace was stopped and restarted, Postgres is restarted by `postStartCommand`; if not, run
> `npm run db:start`. Data persists in `.pgdata/` (gitignored).

---

## Quick start — local machine + ngrok

**Prerequisites:** Node.js 20+, Docker (or any reachable Postgres), and [ngrok](https://ngrok.com/download)
with an auth token configured (`ngrok config add-authtoken <token>`).

```bash
git clone https://github.com/lbrenman/mock-purchase-order-backend.git
cd mock-purchase-order-backend
npm install
cp .env.example .env

npm run db:start          # or: docker compose up -d   (Postgres 16 on localhost:5432)
npm run dev               # http://localhost:3000  (tables + seed data created automatically)
```

In a second terminal, expose it:

```bash
ngrok http 3000
```

Use the `https://<id>.ngrok-free.app` forwarding URL as the base URL in Fusion:

| Backend | Base URL for Fusion | Swagger UI |
|---|---|---|
| ERP | `https://<id>.ngrok-free.app/erp/v1` | `https://<id>.ngrok-free.app/erp/api-docs` |
| SRM | `https://<id>.ngrok-free.app/srm/v1` | `https://<id>.ngrok-free.app/srm/api-docs` |
| TMS | `https://<id>.ngrok-free.app/tms/v1` | `https://<id>.ngrok-free.app/tms/api-docs` |

Notes:
- Free ngrok domains show a browser interstitial. API clients (Fusion, curl) are unaffected, but you can
  add the header `ngrok-skip-browser-warning: true` to be safe.
- The OpenAPI `servers` URL follows `X-Forwarded-Host`, so specs downloaded through ngrok already point at
  the ngrok URL. Set `PUBLIC_BASE_URL` in `.env` to pin it (e.g. a reserved ngrok domain).
- Want three separate "systems" with three URLs? Run `npm run start:separate` and start one tunnel per port
  (`ngrok http 3001`, `3002`, `3003`, or an ngrok config file with three tunnels). Paths keep their
  `/erp`, `/srm`, `/tms` prefixes in both modes.

---

## Other ways to run

**Everything in Docker**

```bash
docker compose -f docker-compose.full.yml up --build
```

**External / hosted Postgres (Neon, Supabase, RDS…)** — no local database needed:

```bash
# .env
DATABASE_URL=postgresql://user:pass@ep-xxxx.us-east-2.aws.neon.tech/po_backends_db?sslmode=require
```

Each backend can also live in its own database to make the "separate systems" story literal:
`ERP_DATABASE_URL`, `SRM_DATABASE_URL`, `TMS_DATABASE_URL`.

**Useful scripts**

| Script | What it does |
|---|---|
| `npm run dev` | Start with nodemon (restarts on changes to `src/` or `openapi/`) |
| `npm start` | Start (production style) |
| `npm run start:separate` | One port per backend (3001/3002/3003) |
| `npm run db:start` | (Re)create the local Postgres container |
| `npm run migrate` | Create schemas/tables (idempotent) |
| `npm run seed` | Load seed data (existing rows untouched) |
| `npm run seed:reset` | **Drop and recreate** all three schemas with fresh demo data |
| `npm run smoke` | Read-only walkthrough; `npm run smoke -- --write` also runs and compensates an ASN saga. `BASE_URL=https://… npm run smoke` to test a tunnel |

---

## Configuration

All variables are documented in [`.env.example`](.env.example). Per-service variables override globals.

| Variable | Default | Description |
|---|---|---|
| `SERVICE_MODE` | `combined` | `combined` (one port) or `separate` (one port per backend) |
| `PORT` | `3000` | Port in combined mode |
| `ERP_PORT` / `SRM_PORT` / `TMS_PORT` | `3001` / `3002` / `3003` | Ports in separate mode |
| `ENABLED_SERVICES` | `erp,srm,tms` | Run a subset |
| `PUBLIC_BASE_URL` | *(derived)* | Public URL used in OpenAPI `servers` |
| `DATABASE_URL` | `postgresql://api_user:api_pass@localhost:5432/po_backends_db` | Shared database |
| `ERP_DATABASE_URL` … | *(DATABASE_URL)* | Per-backend database |
| `AUTO_MIGRATE` / `AUTO_SEED` | `true` / `true` | Create tables / seed empty backends on start |
| `AUTH_MODE` | `apikey` | `apikey` or `none` (global) |
| `ERP_AUTH_MODE` … | *(AUTH_MODE)* | Per-backend override |
| `ERP_API_KEY` / `SRM_API_KEY` / `TMS_API_KEY` | `erp-demo-key` / `srm-demo-key` / `tms-demo-key` | Keys |
| `ERP_API_KEY_HEADER` … | `x-api-key` | Header name per backend |
| `CHAOS_ENABLED` | `true` | Honour `x-mock-status` / `x-mock-delay-ms` headers |
| `ERP_LATENCY_MS` … | `0` | Baseline latency per backend |
| `ERP_ERROR_RATE` … | `0` | Random 503 probability (0–1) per backend |
| `RATE_LIMIT_WINDOW_MS` / `RATE_LIMIT_MAX` | `60000` / `300` | Rate limit per backend (per IP) |
| `LOG_FORMAT` | `dev` | morgan format |

---

## Authentication

Each backend has **its own key** so the Fusion connections look like three different systems:

```
x-api-key: erp-demo-key    → /erp/v1/*
x-api-key: srm-demo-key    → /srm/v1/*
x-api-key: tms-demo-key    → /tms/v1/*
```

Unauthenticated: `/`, `/health`, `/<svc>/health`, `/<svc>/openapi.json|yaml`, `/<svc>/api-docs`.
Disable keys everywhere with `AUTH_MODE=none`, or per backend (e.g. `SRM_AUTH_MODE=none`).
Missing/wrong keys return **401** in the backend's own error dialect.

---

## API reference

Full request/response schemas and examples are in Swagger UI for each backend. Summary:

### ERP — `/erp/v1` (SAP-style purchasing)

| Method | Path | Purpose |
|---|---|---|
| GET | `/reference/status-codes` | `01`–`09` PO status codes |
| GET | `/reference/confirmation-categories` | `AB` / `AC` / `RJ` |
| GET | `/reference/purchasing-orgs` | `JBUS` → `Jabil-US`, … |
| GET | `/plants` `?site_code=` | Plants (`1101` ↔ `US-AUBURN-HILLS`) with addresses |
| GET | `/plants/{plantCode}` | One plant |
| GET | `/purchase-orders` | Filters: `vendor_id`, `status`, `changed_since`, `plant`, `purch_org`, `po_number` (CSV); `page`, `limit`; `include=items` (headers only by default) |
| POST | `/purchase-orders` | Create a PO (buyer side, for demos) |
| GET | `/purchase-orders/{poNumber}` | Header + items, `ETag: W/"<po>-r<revision>"` |
| PATCH | `/purchase-orders/{poNumber}` | Buyer change → **revision + 1** (or `status_code` `05`/`09`) |
| GET | `/purchase-orders/{poNumber}/items` | Items with `confirmed_qty`, `shipped_qty`, `open_qty` |
| GET | `/purchase-orders/{poNumber}/confirmations` | Confirmation history |
| POST | `/purchase-orders/{poNumber}/confirmations` | Vendor confirmation (`AB`/`AC`/`RJ`), optional `If-Match` → 409 per revision, 422 rules, 412 stale |
| GET | `/confirmations/{confirmationNo}` | One confirmation |
| GET | `/inbound-deliveries` | Filters: `asn_reference`, `vendor_id`, `po_number`, `status` |
| POST | `/inbound-deliveries` | Post an ASN against PO items (reserves qty; **422 `SHIPPED_QUANTITY_EXCEEDS_OPEN_QUANTITY`**) |
| GET | `/inbound-deliveries/{deliveryNo}` | One delivery |
| POST | `/inbound-deliveries/{deliveryNo}/reverse` | **Compensation** — releases reserved qty |

Errors: `{ "error": { "code", "message", "details": [{field, message}], "timestamp", "correlation_id" } }`

### SRM — `/srm/v1` (supplier master)

| Method | Path | Purpose |
|---|---|---|
| GET | `/suppliers` | Filters: `status`, `country`, `tier`, `supplierCode`, `erpVendorNumber`, `q`; `expand=contacts,sites`; `offset`, `limit` |
| GET | `/suppliers/{supplierCode}` | Supplier with contacts & sites |
| PATCH | `/suppliers/{supplierCode}` | Demo control: change `status` (`ACTIVE`/`ON_HOLD`/`BLOCKED`), capabilities |
| GET | `/suppliers/{supplierCode}/sites` | Ship-from / remit-to / manufacturing sites |
| GET | `/suppliers/{supplierCode}/contacts` | Contacts |
| GET | `/sites/{siteCode}` | One site (e.g. `SUP-ATL-01`) |
| GET | `/vendor-xref` `?supplierCode=&erpVendorNumber=` | **Batch** SUP ↔ ERP vendor cross-reference (`items` + `unresolved`) |
| GET | `/vendor-xref/{erpVendorNumber}` | Single lookup |
| GET | `/entitlements` | Consumer applications and their supplier/scope grants |
| GET | `/entitlements/{consumerId}` | One consumer |
| GET/POST | `/entitlements/{consumerId}/check` | `{scope, supplierCode}` → always 200 `{allowed, reason}` |

Errors: `{ "errors": [ { "code", "message", "field" } ], "traceId" }`

### TMS — `/tms/v1` (logistics)

| Method | Path | Purpose |
|---|---|---|
| GET | `/carriers` `?code=UPS` `&scac=` | Carrier directory, façade code ↔ SCAC |
| GET | `/milestones` | `PLN TND ITR DLV EXC CXL` |
| GET | `/event-codes` | `PU DEP ARR OFD RES DLV EXC` → resulting milestone |
| GET | `/shipments` | Filters: `supplierCode`, `status` (milestones), `poNumber`, `asnNumber`, `updatedSince`; `limit`, `cursor` |
| POST | `/shipments` | Create ASN (`TND`; `"tender": false` → `PLN`), 409 duplicate ASN, 422 unknown carrier / bad schedule |
| GET | `/shipments/{shipmentId}` | `?include=events` |
| GET | `/shipments/{shipmentId}/events` | Tracking history |
| POST | `/shipments/{shipmentId}/events` | Demo control: carrier event, optional `newEstimatedArrival` |
| POST | `/shipments/{shipmentId}/tender` | `PLN` → `TND` |
| POST | `/shipments/{shipmentId}/cancel` | Cancel / **compensation** |

Errors: `{ "fault": { "faultCode": "tms.X", "faultString", "httpStatus", "detail": [{path, issue}], "correlationId" } }`

### Try it

```bash
B=http://localhost:3000

# Who is SUP-100245 in the ERP?
curl -s -H "x-api-key: srm-demo-key" "$B/srm/v1/vendor-xref?supplierCode=SUP-100245"

# May the Apex portal act for that supplier?
curl -s -H "x-api-key: srm-demo-key" \
  "$B/srm/v1/entitlements/apex-supplier-portal/check?scope=supplier-orders.write&supplierCode=SUP-100245"

# The PO in ERP format
curl -s -H "x-api-key: erp-demo-key" "$B/erp/v1/purchase-orders/4500123456"

# Accept it with a later date (→ IN_REVIEW, façade PENDING_REVIEW)
curl -s -X POST -H "x-api-key: erp-demo-key" -H "content-type: application/json" \
  -H "Idempotency-Key: ack-4500123456-demo" \
  -d '{"conf_category":"AC","vendor_reference":"SUP-ACK-88419","items":[{"item_no":"00010","confirmed_qty":250,"confirmed_date":"20261008"}]}' \
  "$B/erp/v1/purchase-orders/4500123456/confirmations"

# Map UPS to its SCAC, then look at an in-transit shipment
curl -s -H "x-api-key: tms-demo-key" "$B/tms/v1/carriers?code=UPS"
curl -s -H "x-api-key: tms-demo-key" "$B/tms/v1/shipments/SHP-20260918-00121?include=events"
```

---

## Façade coverage

Every capability implied by the Supplier Order Collaboration API is backed by real behaviour:

| Façade operation | Backends involved | Key behaviours |
|---|---|---|
| `GET /purchase-orders` | SRM (entitlement, xref) → ERP (list, items, plants, purch orgs) | supplier filter via xref, status/updatedSince filters, paging, fan-out |
| `GET /purchase-orders/{id}` | ERP → SRM (xref + entitlement) | `PO-` prefix stripping, ETag, shipTo from plant, 403/404 |
| `POST /purchase-orders/{id}/acknowledgements` | SRM (write entitlement) → ERP (confirmation) | ACCEPT/ACCEPT_WITH_CHANGES/REJECT → AB/AC/RJ, 409 per revision, 422 rules, RECORDED/PENDING_REVIEW/REJECTED, idempotency |
| `POST /shipments` | SRM (entitlement, supplier status, site) → TMS (carrier map, create) → ERP (inbound delivery) | 422 over-shipment, 409 duplicate ASN, **compensation** via TMS cancel or ERP reverse |
| `GET /shipments` | SRM → TMS | purchaseOrderId → poNumber filter, milestone → status, cursor ↔ pageToken |
| `GET /shipments/{id}` | TMS → SRM | reshaping, carrier SCAC → code, milestone → status |
| Cross-cutting | all | 401 per backend, 429 rate limits, 503 chaos, correlation IDs, three error dialects → ProblemDetails |

See [docs/MAPPING.md](docs/MAPPING.md) for the exact recipes and seed-data cheat-sheet.

---

## Demo controls

**Per-request chaos headers** (when `CHAOS_ENABLED=true`, sent to any `/<svc>/v1/*` call):

| Header | Effect |
|---|---|
| `x-mock-status: 503` | Returns that status (400–599) in the backend's error dialect — e.g. force the ERP step of the ASN saga to fail and show compensation |
| `x-mock-delay-ms: 2500` | Adds latency (max 30 s) — show timeouts or parallel vs. sequential fan-out |

**Per-backend environment settings:** `ERP_LATENCY_MS=400`, `TMS_ERROR_RATE=0.3`, etc.

**Business state changes (no SQL needed):**

| Scenario | Call |
|---|---|
| Supplier goes on hold → write denied | `PATCH /srm/v1/suppliers/SUP-100245 {"status":"ON_HOLD","statusReason":"Quality audit"}` |
| Buyer changes the PO → new revision can be acknowledged again | `PATCH /erp/v1/purchase-orders/4500123456 {"delivery_date":"20261012"}` |
| Shipment delayed | `POST /tms/v1/shipments/SHP-20260918-00121/events {"eventCode":"EXC","newEstimatedArrival":"2026-09-29T17:00:00Z"}` |
| Shipment delivered | `POST /tms/v1/shipments/SHP-20260918-00121/events {"eventCode":"DLV"}` |
| Start over | `npm run seed:reset` |

---

## Using the specs in Amplify Fusion

1. Download each spec from `https://<public-url>/<svc>/openapi.yaml` (or `.json`). The `servers` entry
   already contains the public base URL (e.g. `https://<id>.ngrok-free.app/erp`).
2. Create one **HTTP/OpenAPI connection per backend** in Fusion with an API-key header `x-api-key` and the
   matching key — three connections make the multi-system story obvious in the flows.
3. Implement the façade from `Jabil_Supplier_Order_Collaboration_OpenAPI_3.1.yaml` using the recipes in
   [docs/MAPPING.md](docs/MAPPING.md): SRM entitlement check → ERP/TMS calls → transformations →
   ProblemDetails normalization.
4. Propagate `X-Correlation-Id` to each backend so a single ID shows up in every backend log line and error.

If your URL changes (new ngrok session / new Codespace), only the connection base URLs need updating.

---

## Project structure

```
mock-purchase-order-backend/
├── .devcontainer/devcontainer.json     Codespaces: Node 20 + docker-in-docker, auto-starts Postgres
├── openapi/                            erp.yaml · srm.yaml · tms.yaml (OpenAPI 3.0.3)
├── docs/MAPPING.md                     façade ↔ backend mappings & orchestration recipes
├── scripts/
│   ├── start-postgres.sh               (re)creates the local Postgres container
│   └── smoke-test.js                   end-to-end walkthrough (Node 20 fetch)
├── src/
│   ├── index.js                        startup: migrate → seed → listen (combined|separate)
│   ├── app.js                          express app, landing page, aggregate /health
│   ├── config.js                       env handling (global + per-service)
│   ├── shared/                         errors, db pools, middleware (auth, chaos, idempotency,
│   │                                   correlation, rate limit), validation, docs, service factory
│   ├── db/schema/{erp,srm,tms}.sql     DDL per backend schema
│   ├── db/migrate.js
│   ├── data/{erp,srm,tms}.json         consistent seed data
│   ├── data/seed.js
│   └── services/{erp,srm,tms}/         routes + error dialect per backend
├── docker-compose.yml                  Postgres only
├── docker-compose.full.yml             Postgres + API
├── Dockerfile
└── .env.example
```

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Database initialisation failed … ECONNREFUSED` | Postgres isn't running: `npm run db:start` (or `docker compose up -d`). `/health` reports `database: down` until it is. |
| Fusion gets an HTML login page from Codespaces | Port 3000 visibility must be **Public**. |
| Fusion/curl gets ngrok HTML | Add header `ngrok-skip-browser-warning: true`. |
| `401` everywhere | Each backend has its own key (`erp-demo-key`, `srm-demo-key`, `tms-demo-key`) or set `AUTH_MODE=none`. |
| ERP `400 INVALID_PO_NUMBER` | Strip the façade `PO-` prefix — that's intentional. |
| `409 CONFIRMATION_EXISTS` on a re-run | Acknowledgements are one-per-revision. `PATCH` the PO to bump the revision or `npm run seed:reset`. |
| Swagger "Try it out" hits the wrong host | Set `PUBLIC_BASE_URL` in `.env`. |
| Port already in use | Change `PORT` (or `ERP_PORT` etc.) in `.env`. |
| Postgres container won't start after a crash | `docker rm -f po-backends-postgres && npm run db:start`; as a last resort delete `.pgdata/` (data is re-seeded). |

---

**Disclaimer:** all data is fictitious and for demonstration only. This is not a representation of any
production Jabil system.
