# Mock Purchase Order Backends (ERP · SRM · TMS)

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/lbrenman/mock-purchase-order-backend)

Three **independent, deliberately different** mock systems of record — built with Node.js/Express and
PostgreSQL — that sit behind a **Supplier Order Collaboration API** façade (OpenAPI 3.1) implemented in
**Axway Amplify Fusion**.

The backends are *not* a proxy target for the façade. Each one owns a different slice of the data,
speaks its own dialect (naming, identifiers, dates, status codes, pagination, error format), and none of
them can answer a façade request on its own. That's the point: the iPaaS has to **orchestrate,
transform and aggregate** — visibly. The orchestration is kept deliberately compact: every façade
operation is two or three backend calls, always one SRM call plus one or two ERP or TMS calls.

```mermaid
flowchart LR
    C[Supplier portal / internal app] -->|Supplier Order Collaboration API<br/>PO-4500123456 · SUP-100245 · ProblemDetails| F[Amplify Fusion<br/>integration]
    F -->|entitlement check: may this consumer act,<br/>and which ERP vendor is the supplier?| SRM[(SRM<br/>/srm/v1)]
    F -->|POs with items and ship-to · confirmations · inbound deliveries| ERP[(ERP<br/>/erp/v1)]
    F -->|ASNs · milestones · tracking| TMS[(TMS<br/>/tms/v1)]
```

| Backend | Path | Plays the role of | Dialect highlights |
|---|---|---|---|
| **ERP** | `/erp` | SAP-style purchasing system | `po_number` 10 digits (no `PO-`), `vendor_id` `0000710245`, `item_no` `"00010"`, status `01…09`, dates `YYYYMMDD`, decimals as strings, `{data, pagination}` page/limit; every PO embeds its items, `ship_to` address and `purch_org_name` |
| **SRM** | `/srm` | Supplier master / supplier relationship mgmt | nested camelCase, owns `SUP-xxxxxx` and the ERP vendor numbers, supplier sites, **consumer entitlements**; one **check** call answers "may this consumer act?" and "which ERP vendor is this supplier?", offset paging |
| **TMS** | `/tms` | Transportation management system | carriers stored by **SCAC** (`UPSN`) but accepted by business code (`UPS`), milestones `PLN/TND/ITR/DLV/EXC/CXL`, nested quantities/weights, **cursor** paging, SOAP-fault-style errors |

➡️ **[docs/MAPPING.md](docs/MAPPING.md)** is the answer key: every field, code and status mapping plus
the backend calls for each façade operation (including the ASN saga with compensation):

| Façade operation | Backend calls |
|---|---|
| `GET /purchase-orders` | SRM check → ERP list |
| `GET /purchase-orders/{id}` | ERP get → SRM check |
| `POST /purchase-orders/{id}/acknowledgements` | ERP get → SRM check → ERP confirmation |
| `POST /shipments` | SRM check → TMS create → ERP inbound delivery (TMS cancel if it fails) |
| `GET /shipments`, `GET /shipments/{id}` | SRM check → TMS list, or TMS get → SRM check |

---

## Contents

- [Features](#features)
- [Quick start — GitHub Codespaces](#quick-start--github-codespaces)
- [Quick start — local machine + ngrok](#quick-start--local-machine--ngrok)
- [Other ways to run](#other-ways-to-run)
- [Data dashboard](#data-dashboard)
- [Postman collection](#postman-collection)
- [Seed data](#seed-data)
- [Configuration](#configuration)
- [Authentication](#authentication)
- [API reference](#api-reference)
- [Façade coverage](#façade-coverage)
- [Demo controls (chaos, latency, state changes)](#demo-controls)
- [Using the specs in Amplify Fusion](#using-the-specs-in-amplify-fusion)
- [Development tools](#development-tools)
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
  revision (409), locked POs, supplier scope (403 via SRM), duplicate ASN (a cancelled shipment frees its ASN
  for a retry), unknown carrier, stale revision (412 `If-Match`), plus **compensation endpoints** for saga demos.
- **Idempotency-Key** support on every POST (safe retries; replays flagged with `Idempotent-Replayed: true`).
- **X-Correlation-Id** accepted/generated and echoed in headers and errors (end-to-end tracing).
- **Chaos & latency controls** to show retries, timeouts, parallel fan-out and circuit breaking.
- **Rich, consistent seed data**: 23 suppliers, 74 purchase orders, 40 shipments and every status, milestone
  and governance case, with the same PO / supplier / ASN identifiers lining up across all three systems.
- **Full CRUD maintenance endpoints** on every entity (plants, purchasing orgs, POs and items, suppliers,
  sites, contacts, entitlements, carriers, shipments) with realistic referential-integrity conflicts (409).
- **Data dashboard** at `/dashboard/`: list and detail views for every entity, create/edit/delete forms,
  cross-system views of one record, and a live **wire log** of every backend call.
- **Postman collection** covering all 74 operations: 164 requests, each with a description, tests and a saved
  example response, chained IDs with clear messages when a prerequisite is missing, plus one scenario folder
  per façade operation with exactly the calls the iPaaS makes.

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
   - `…/dashboard/` — the data dashboard (browse and edit all three backends)

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

The dashboard is at `https://<id>.ngrok-free.app/dashboard/` and the Postman **Tunnel** environment only needs
`baseUrl` set to the forwarding URL.

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

## Data dashboard

Open **`/dashboard/`** on the same host (for example `http://localhost:3000/dashboard/` or
`https://<codespace-name>-3000.app.github.dev/dashboard/`). It is plain HTML/JS served by the backend,
with no build step, and it talks to the three backends through their public REST APIs exactly like any other
consumer, so everything you do there shows up in the ERP/SRM/TMS data the iPaaS sees.

| Area | Pages | What you can do |
|---|---|---|
| **Overview** | Order-to-dock pipeline | PO status counts (ERP), shipment milestones (TMS), supplier statuses (SRM); exceptions, confirmations in review, overdue POs, and open orders with suppliers on hold or blocked (a cross-system join). Every count opens the filtered list. |
| **ERP** | Purchase orders, Confirmations, Inbound deliveries, Plants, Purchasing orgs | Create POs; edit header; add, edit and delete items; record supplier confirmations (AB/AC/RJ, optional `If-Match`); post and reverse inbound deliveries; close, cancel, delete; CRUD for plants and purchasing orgs |
| **SRM** | Suppliers, Sites, Contacts, Entitlements | CRUD for all four; put a supplier on hold, block or reactivate it; run the entitlement **check** the façade uses |
| **TMS** | Shipments, Carriers | Create shipments (origin picked from SRM sites, destination from ERP plants), tender, post tracking events, edit, cancel, delete drafts; CRUD for carriers |

Every detail panel has four tabs worth showing in a demo:

- **Details**: the record, with links to related records.
- **Across systems**: the same business object as seen by the other two backends (for a PO: SRM supplier via
  the vendor cross-reference and TMS shipments carrying the PO), with the exact call used to fetch it.
- **Wire JSON**: the untouched backend payload, so the different dialects are visible side by side.
- The **Wire log** bar at the bottom lists every call the dashboard made (backend, method, path, status,
  latency) and expands to show request headers, request body and response body.

**Connection settings** (bottom of the navigation rail) lets you point each backend at another base URL or
API key; values are stored in your browser only. The page pre-fills the demo API keys only while the server
still uses the published defaults (`DASHBOARD_PREFILL_DEMO_KEYS=true`). With custom keys, enter them once in
Connection settings. Set `DASHBOARD_ENABLED=false` to turn the dashboard off.

In `SERVICE_MODE=separate` the dashboard is served by each backend's port and calls the other two on their
own ports (`http://<host>:3002/srm`, …). Behind three separate tunnels set `ERP_PUBLIC_URL`, `SRM_PUBLIC_URL`
and `TMS_PUBLIC_URL` to the tunnel URLs (without the `/erp` suffix).

> Errors are shown exactly as each backend reports them (the dashboard normalises the three error dialects
> for display), so a 409 like `PLANT_IN_USE` or `SUPPLIER_HAS_ENTITLEMENTS` is a feature, not a bug.

---

## Postman collection

`postman/` contains:

| File | Purpose |
|---|---|
| `mock-po-backends.postman_collection.json` | 164 requests covering **every operation** of all three backends (74), plus error and security cases and one scenario per façade operation |
| `local.postman_environment.json` | `baseUrl = http://localhost:3000` (combined mode) |
| `local-separate.postman_environment.json` | `erpUrl`, `srmUrl`, `tmsUrl` on ports 3001/3002/3003 |
| `tunnel.postman_environment.json` | Set `baseUrl` to your ngrok or Codespaces URL (`https://<codespace-name>-3000.app.github.dev`) |

**Import:** Postman → *Import* → drop the four files → select an environment (or just edit the `baseUrl`
collection variable).

**What every request has:**

- a **description** with the expected status, the variables it needs and which earlier request sets
  them (**Needs**), and the variables it saves (**Saves**);
- **tests** (expected status plus business assertions such as "status is 04" or "reason is SUPPLIER_ON_HOLD");
- a **saved example response**, so you can read the whole API in Postman without a running server.

**Structure:**

- **ERP / SRM / TMS folders**: one folder per backend with its API key as folder auth (`{{erpApiKey}}`,
  `{{srmApiKey}}`, `{{tmsApiKey}}`). Requests run top to bottom as a lifecycle: create → read → change →
  business actions → negative cases → delete. IDs returned by create calls (`poNumber`, `supplierCode`,
  `shipmentId`, …) are saved in collection variables, each folder cleans up what it created, and a fresh
  `runId` at the start of each backend folder keeps repeated runs from colliding.
- **Scenarios - façade walkthroughs**: for each façade operation, exactly the backend calls from
  [docs/MAPPING.md](docs/MAPPING.md), in order:
  1. get one purchase order (ERP → SRM check by vendor number);
  2. list purchase orders (SRM check → ERP list for the allowed vendors);
  3. acknowledge a purchase order (ERP → SRM check → ERP confirmation, then the 409 on a repeat);
  4. create an ASN, happy path: SRM check → TMS shipment → ERP delivery for two POs, then the façade response
     built from the backend answers by the test script (see the **Visualize** tab) → clean-up;
  5. create an ASN when the ERP step fails: ERP delivery forced to fail with `x-mock-status: 503` →
     TMS cancel (compensation) → successful retry with the same ASN → clean-up;
  6. track a shipment (TMS → SRM check);
  7. governance decisions (supplier on hold, revoked consumer, multi-supplier network).

**Sending single requests:** requests on seed data (fixed IDs such as PO `4500123458`) work on their own.
A request that uses an ID created by an earlier request stops before sending if that variable is still empty,
with a message such as *"{{poNumber}} is empty. Send "ERP - Purchasing / Purchase orders / Create purchase
order" first, or run the folder in order."*

**Run from the command line** (Newman):

```bash
npx newman run postman/mock-po-backends.postman_collection.json \
  -e postman/local.postman_environment.json
# a single backend or scenario:
npx newman run postman/mock-po-backends.postman_collection.json \
  -e postman/local.postman_environment.json --folder "TMS - Logistics"
```

`npm run postman` is a shortcut for the first command. Some requests deliberately use `x-mock-status` and
`x-mock-delay-ms`, so keep `CHAOS_ENABLED=true` (the default) for a green run. The scenarios clean up after
themselves; purchase orders created by the ERP folder and scenario 3 stay (cancelled or open) until
`npm run seed:reset`.

---

## Seed data

The seed files in `src/data/` are loaded automatically into empty databases (and on `npm run seed:reset`).
Identifiers are consistent across systems: ERP vendor `0000710245` is SRM `SUP-100245`; every ERP inbound
delivery has a TMS shipment with the same ASN; ERP `shipped_qty` equals the posted deliveries; cancelled
shipments have reversed deliveries.

| System | Entity | Count | Highlights |
|---|---|---|---|
| ERP | Purchasing orgs | 9 | JBUS, JBMX, JBDE, JBSG, JBCN, JBMY, JBVN, JBPL, JBHU |
| ERP | Plants | 13 | US, MX, DE, HU, PL, SG, MY, CN, VN sites |
| ERP | Purchase orders | 74 | all statuses: 16 open, 6 partially confirmed, 16 confirmed, 23 in delivery, 8 closed, 5 cancelled; USD, EUR, PLN, CNY |
| ERP | Confirmations | 54 | AB, AC (incl. IN_REVIEW) and RJ |
| ERP | Inbound deliveries | 34 | incl. 3 REVERSED (saga compensation) |
| SRM | Suppliers | 23 | 19 active, 2 on hold, 2 blocked; 15 countries; one newly onboarded supplier with no orders |
| SRM | Sites / contacts | 27 / 58 | ship-from, remit-to and manufacturing sites |
| SRM | Entitlements | 19 | single-supplier portals, multi-supplier networks, internal apps, read-only and revoked consumers |
| TMS | Carriers | 12 | parcel, LTL, FTL, air and ocean (UPS/UPSN, FedEx/FDEG, DHL, Maersk, CMA CGM, Kuehne+Nagel, …) |
| TMS | Shipments / events | 40 / 137 | 6 planned, 5 tendered, 9 in transit, 4 exceptions, 13 delivered, 3 cancelled |

The original demo records (POs 4500123456–4500123468, shipments 00088/00107/00121/00188) are unchanged; see
the [seed cheat-sheet in docs/MAPPING.md](docs/MAPPING.md#5-seed-data-cheat-sheet) for which record to use
for which demo.

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
| `DASHBOARD_ENABLED` | `true` | Serve the data dashboard at `/dashboard/` |
| `DASHBOARD_PREFILL_DEMO_KEYS` | `true` | Let the dashboard pre-fill API keys, only while they are the published demo defaults |
| `ERP_PUBLIC_URL` / `SRM_PUBLIC_URL` / `TMS_PUBLIC_URL` | *(empty)* | Browser-facing base URL of each backend for the dashboard (separate mode behind tunnels) |

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
| GET | `/reference/purchasing-orgs` | Purchasing org codes and names (maintenance; POs already carry `purch_org_name`) |
| POST | `/reference/purchasing-orgs` | Create a purchasing org |
| GET / PATCH / DELETE | `/reference/purchasing-orgs/{code}` | Read, change, delete (409 `PURCH_ORG_IN_USE`) |
| GET | `/plants` `?site_code=` | Plants (`1101` ↔ `US-AUBURN-HILLS`) with addresses (maintenance; POs already carry `ship_to`) |
| POST | `/plants` | Create a plant |
| GET / PATCH / DELETE | `/plants/{plantCode}` | Read, change, delete (409 `PLANT_IN_USE`) |
| GET | `/purchase-orders` | Filters: `vendor_id`, `status`, `changed_since`, `plant`, `purch_org`, `po_number` (CSV); `page`, `limit`. Every entry includes items, `ship_to` and `purch_org_name` |
| POST | `/purchase-orders` | Create a PO (buyer side, for demos) |
| GET | `/purchase-orders/{poNumber}` | Header, `ship_to`, `purch_org_name` and items; `ETag: W/"<po>-r<revision>"` |
| PATCH | `/purchase-orders/{poNumber}` | Buyer change (`delivery_date`, `buyer_name`, `incoterms`, `payment_terms`, item qty/price) → **revision + 1** (or `status_code` `05`/`09`) |
| DELETE | `/purchase-orders/{poNumber}` | Only without confirmations/deliveries (409 `PO_HAS_FOLLOW_ON_DOCUMENTS`) |
| GET | `/purchase-orders/{poNumber}/items` | Items with `confirmed_qty`, `shipped_qty`, `open_qty` |
| POST | `/purchase-orders/{poNumber}/items` | Add an item (next `item_no`), revision + 1 |
| PATCH / DELETE | `/purchase-orders/{poNumber}/items/{itemNo}` | Change (422 `QUANTITY_BELOW_SHIPPED`) or delete (409 if confirmed/shipped, 422 `LAST_ITEM`) |
| GET | `/purchase-orders/{poNumber}/confirmations` | Confirmation history |
| POST | `/purchase-orders/{poNumber}/confirmations` | Vendor confirmation (`AB`/`AC`/`RJ`), optional `If-Match` → 409 per revision, 422 rules, 412 stale |
| GET | `/confirmations` | All confirmations; filters `po_number`, `status`, `conf_category`, `vendor_id`; page/limit |
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
| POST | `/suppliers` | Create a supplier (`supplierCode` optional, auto-assigned) |
| PATCH | `/suppliers/{supplierCode}` | Master data and demo control: `status` (`ACTIVE`/`ON_HOLD`/`BLOCKED`), classification, capabilities, names, country, DUNS |
| DELETE | `/suppliers/{supplierCode}` | Delete with sites and contacts (409 `SUPPLIER_HAS_ENTITLEMENTS`) |
| GET / POST | `/suppliers/{supplierCode}/sites` | List or add sites |
| GET / POST | `/suppliers/{supplierCode}/contacts` | List or add contacts (`CNT-####` assigned) |
| GET | `/sites` | All sites; filters `supplierCode`, `type`, `country`, `active`; offset paging |
| GET / PATCH / DELETE | `/sites/{siteCode}` | One site (e.g. `SUP-ATL-01`) |
| GET | `/contacts` | All contacts; filters `supplierCode`, `role`, `q`; offset paging |
| GET / PATCH / DELETE | `/contacts/{contactId}` | One contact |
| GET | `/vendor-xref` `?supplierCode=&erpVendorNumber=` | Batch SUP ↔ ERP vendor cross-reference (`items` + `unresolved`); ad-hoc lookups, the check already covers the façade |
| GET | `/vendor-xref/{erpVendorNumber}` | Single lookup |
| GET | `/entitlements` | Consumer applications and their supplier/scope grants |
| POST | `/entitlements` | Register a consumer (`suppliers[]` or `allSuppliers`, `scopes[]`) |
| GET / PATCH / DELETE | `/entitlements/{consumerId}` | One consumer |
| GET/POST | `/entitlements/{consumerId}/check` | `scope` plus `supplierCode` **or** `erpVendorNumber` (or neither for lists) → always 200 `{allowed, reason, supplier, allowedSuppliers, allowedVendors}`. The one SRM call per façade request |

Errors: `{ "errors": [ { "code", "message", "field" } ], "traceId" }`

### TMS — `/tms/v1` (logistics)

| Method | Path | Purpose |
|---|---|---|
| GET | `/carriers` `?code=UPS` `&scac=` | Carrier directory, business code ↔ SCAC |
| POST | `/carriers` | Create a carrier |
| GET / PATCH / DELETE | `/carriers/{carrierCode}` | By code or SCAC; GET adds `shipmentsByMilestone`; DELETE 409 `CARRIER_IN_USE` |
| GET | `/milestones` | `PLN TND ITR DLV EXC CXL` |
| GET | `/event-codes` | `PU DEP ARR OFD RES DLV EXC` → resulting milestone |
| GET | `/shipments` | Filters: `supplierCode`, `status` (milestones), `poNumber`, `asnNumber`, `carrier` (SCAC or code), `updatedSince`; `limit`, `cursor` |
| POST | `/shipments` | Create ASN (`TND`; `"tender": false` → `PLN`); carrier by `carrier.carrierCode` (`UPS`) or `carrier.scac`; 409 duplicate ASN (cancelled shipments excluded), 422 unknown carrier / bad schedule |
| GET | `/shipments/{shipmentId}` | `?include=events` |
| PATCH | `/shipments/{shipmentId}` | Tracking ID and ETA while open; carrier (code or SCAC), route, ship date, handling units only in PLN/TND; contents and ASN only in PLN (409 `FIELD_LOCKED`) |
| DELETE | `/shipments/{shipmentId}` | Planned (PLN) drafts only (409 `SHIPMENT_NOT_DRAFT`) |
| GET | `/shipments/{shipmentId}/events` | Tracking history |
| POST | `/shipments/{shipmentId}/events` | Demo control: carrier event, optional `newEstimatedArrival` |
| POST | `/shipments/{shipmentId}/tender` | `PLN` → `TND` |
| POST | `/shipments/{shipmentId}/cancel` | Cancel / **compensation** |

Errors: `{ "fault": { "faultCode": "tms.X", "faultString", "httpStatus", "detail": [{path, issue}], "correlationId" } }`

### Try it

```bash
B=http://localhost:3000

# May the Apex portal act for SUP-100245, and which ERP vendor is it? (one call)
curl -s -H "x-api-key: srm-demo-key" \
  "$B/srm/v1/entitlements/apex-supplier-portal/check?scope=supplier-orders.write&supplierCode=SUP-100245"

# Its open orders in ERP format, with items, ship-to address and buying org embedded
curl -s -H "x-api-key: erp-demo-key" "$B/erp/v1/purchase-orders?vendor_id=0000710245&status=01"

# Starting from a PO instead: resolve and authorize by the ERP vendor number
curl -s -H "x-api-key: srm-demo-key" \
  "$B/srm/v1/entitlements/apex-supplier-portal/check?scope=supplier-orders.read&erpVendorNumber=0000710245"

# Accept PO 4500123456 with a later date (→ IN_REVIEW, façade PENDING_REVIEW)
curl -s -X POST -H "x-api-key: erp-demo-key" -H "content-type: application/json" \
  -H "Idempotency-Key: ack-4500123456-demo" \
  -d '{"conf_category":"AC","vendor_reference":"SUP-ACK-88419","items":[{"item_no":"00010","confirmed_qty":250,"confirmed_date":"20261008"}]}' \
  "$B/erp/v1/purchase-orders/4500123456/confirmations"

# An in-transit shipment with its tracking history
curl -s -H "x-api-key: tms-demo-key" "$B/tms/v1/shipments/SHP-20260918-00121?include=events"
```

---

## Façade coverage

Every capability implied by the Supplier Order Collaboration API is backed by real behaviour:

| Façade operation | Backend calls | Key behaviours |
|---|---|---|
| `GET /purchase-orders` | SRM check → ERP list | supplier filter via `allowedVendors`, status and updatedSince filters, paging |
| `GET /purchase-orders/{id}` | ERP get → SRM check (by vendor) | `PO-` prefix stripping, ETag, shipTo and buyingOrganization already embedded, 403/404 |
| `POST /purchase-orders/{id}/acknowledgements` | ERP get → SRM check (write) → ERP confirmation | ACCEPT/ACCEPT_WITH_CHANGES/REJECT → AB/AC/RJ, 409 per revision, 422 rules, RECORDED/PENDING_REVIEW/REJECTED, idempotency |
| `POST /shipments` | SRM check (write) → TMS create → ERP inbound delivery | carrier code passed through, 422 over-shipment, 409 duplicate ASN, **compensation** by TMS cancel, retry with the same ASN |
| `GET /shipments` | SRM check → TMS list | purchaseOrderId → poNumber filter, milestone → status, cursor ↔ pageToken |
| `GET /shipments/{id}` | TMS get → SRM check | reshaping, milestone → status |
| Cross-cutting | all | 401 per backend, 429 rate limits, 503 chaos, correlation IDs, three error dialects → ProblemDetails |

See [docs/MAPPING.md](docs/MAPPING.md) for the field mappings, recipes and seed-data cheat-sheet.

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
3. Implement the façade (Supplier Order Collaboration API, OpenAPI 3.1) using the recipes in
   [docs/MAPPING.md](docs/MAPPING.md): one SRM check → one or two ERP/TMS calls → transformations →
   ProblemDetails normalization. The Postman *Scenarios* folder shows each sequence with real responses.
4. Propagate `X-Correlation-Id` to each backend so a single ID shows up in every backend log line and error.

If your URL changes (new ngrok session / new Codespace), only the connection base URLs need updating.

---

## Development tools

Helpers for changing the project safely live in `tools/`. The two checks need only Node; the generators
and the stub need Python 3 (preinstalled in the Codespaces image) and no extra packages.

| Command | What it does |
|---|---|
| `npm run check` | Runs both checks below; do this before every commit |
| `npm run validate:seed` | Cross-system consistency of `src/data/*.json` (shipped quantities vs. deliveries, PO status rule, ERP delivery ↔ TMS shipment contents, reversed ↔ cancelled, ID sequences, no future dates) |
| `npm run check:postman` | Every operation in `openapi/*.yaml` has at least one request in the Postman collection |
| `npm run build:seed` | Regenerates `src/data/*.json` from the hand-curated records in `tools/seed/base/` (deterministic: an unchanged generator reproduces the committed files byte for byte) |
| `npm run build:postman` | Regenerates the Postman collection and environments from `tools/build-postman.py` (edit the script, not the JSON) |
| `npm run dashboard:stub` | Serves the dashboard with a dependency-free stub backend on `http://127.0.0.1:8765/dashboard/`, reading the seed files; handy for UI work without Postgres (writes are echoed, not stored) |

Typical change workflows:

- **New or changed endpoint:** routes in `src/services/<svc>/routes.js` → `openapi/<svc>.yaml` → request(s) in
  `tools/build-postman.py` → `npm run build:postman` → dashboard view in `public/dashboard/js/views/` →
  README API table → `npm run check`.
- **Seed data:** edit `tools/seed/expand_seed.py` (or the base records) → `npm run build:seed` →
  `npm run validate:seed` → `npm run seed:reset` to load it. Keep the anchor records unchanged, because the
  docs and Postman scenarios rely on them.
- **Dashboard only:** `npm run dashboard:stub`, edit files under `public/dashboard/`, reload the browser.

`CLAUDE.md` summarises the conventions for AI assistants (Claude Code in Codespaces, or a Claude project)
and `CHANGELOG.md` records what changed in each version.

---

## Project structure

```
mock-purchase-order-backend/
├── .devcontainer/devcontainer.json     Codespaces: Node 20 + docker-in-docker, auto-starts Postgres
├── openapi/                            erp.yaml · srm.yaml · tms.yaml (OpenAPI 3.0.3)
├── public/dashboard/                   data dashboard (index.html, css/, js/ ES modules, js/views/{erp,srm,tms,overview}.js)
├── postman/                            collection + local / local-separate / tunnel environments (generated)
├── tools/
│   ├── validate-seed.js                seed consistency check (npm run validate:seed)
│   ├── check-postman-coverage.js       spec ↔ collection coverage (npm run check:postman)
│   ├── build-postman.py                generates postman/ (npm run build:postman)
│   ├── dashboard-stub.py               stub backend for dashboard work (npm run dashboard:stub)
│   └── seed/expand_seed.py + base/     generates src/data/*.json (npm run build:seed)
├── CLAUDE.md                           conventions for AI-assisted changes
├── CHANGELOG.md
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
| Dashboard shows "Could not reach the ERP backend" | Check *Connection settings*: in separate mode behind tunnels set `ERP_PUBLIC_URL` etc., or type the URLs in the dialog. |
| Dashboard calls return 401 | You changed the API keys: enter them in *Connection settings* (keys are pre-filled only for the demo defaults). |
| Postman run fails on the chaos requests | Keep `CHAOS_ENABLED=true`, or skip the *Errors & security* folders. |
| Postman: *"{{poNumber}} is empty. Send … first"* | The request uses an ID created earlier in its folder. Send the named request first, or run the whole folder. |
| Postman `409` on create after an interrupted run | Run the backend folder from its first request (it generates a new `runId`) or `npm run seed:reset`. |
| TMS `409` on an ASN whose shipment was cancelled | You are on a database created before v2.2: restart the server once so the migration replaces the old unique constraint. |
| Postgres container won't start after a crash | `docker rm -f po-backends-postgres && npm run db:start`; as a last resort delete `.pgdata/` (data is re-seeded). |

---

**Disclaimer:** all data is fictitious and for demonstration only. It does not represent any production
system.
