# Façade ↔ Backend Mapping & Orchestration Guide

This document is the "answer key" for building the **Jabil Supplier Order Collaboration API**
(`Jabil_Supplier_Order_Collaboration_OpenAPI_3.1.yaml`) in Amplify Fusion on top of the three mock
backends. Every façade operation needs at least two backends and non-trivial transformation.

| Backend | Base path | Owns | Dialect |
|---|---|---|---|
| **ERP** (SAP-style purchasing) | `/erp/v1` | POs, items, confirmations, inbound deliveries, plants, purchasing orgs | snake_case, `YYYYMMDD` dates, decimals as strings, status codes `01..09`, `{data, pagination}` |
| **SRM** (supplier master) | `/srm/v1` | Supplier identity `SUP-xxxxxx`, sites, contacts, ERP vendor xref, consumer entitlements | nested camelCase, offset paging `{total, offset, limit, items}` |
| **TMS** (logistics) | `/tms/v1` | Shipments/ASNs, carriers (SCAC), milestones, tracking events | nested objects, milestone codes, cursor paging `{count, results, nextCursor}` |

Headers to pass to every backend: `x-api-key` (per backend), `X-Correlation-Id` (propagate the
façade's value — every backend echoes it and includes it in errors). Optional `Idempotency-Key` on POSTs
(derive per-backend keys from the façade key, e.g. `<key>-tms`, `<key>-erp`).

---

## 1. Identifier & code mappings

| Concept | Façade | ERP | SRM | TMS |
|---|---|---|---|---|
| Purchase order | `PO-4500123456` | `4500123456` (strict: prefix → 400 `INVALID_PO_NUMBER`) | — | `contents[].poNumber` = `4500123456` |
| PO line | `lineNumber: 10` (int) | `item_no: "00010"` (5-digit zero-padded string) | — | `poLine: 10` |
| Supplier | `supplierId: SUP-100245` | `vendor_id: "0000710245"` | `supplierCode` ↔ `erpVendorNumber` via `/vendor-xref` | `supplierCode: SUP-100245` |
| Buying org | `buyingOrganization: Jabil-US` | `purch_org: JBUS` | — | — |
| Ship-to | `shipTo.siteCode: US-AUBURN-HILLS` | `plant: "1101"` → `/plants/1101` → `site_code` | — | `route.destination.locationCode` |
| Ship-from | `shipFrom.siteCode: SUP-ATL-01` | — | `/sites/SUP-ATL-01` | `route.origin.locationCode` |
| Carrier | `carrierCode: UPS` | — | — | `carrier.scac: UPSN` (`/carriers?code=UPS`) |
| ASN number | `shipmentNoticeNumber` | `asn_reference` | — | `asnNumber` |
| Acknowledgement id | `ACK-20260923-000184` | `confirmation_no: 7100000101` | — | — |

Suggested acknowledgement id: `ACK-` + `posted_at[0..8]` + `-` + last 6 digits of `confirmation_no`.

### Address shapes

| Façade `Address` | ERP plant | SRM site `address` | TMS location |
|---|---|---|---|
| `siteCode` | `site_code` | `siteCode` (top level) | `locationCode` |
| `name` | `name` | `name` (top level) | `name` |
| `addressLine1` | `street` | `line1` | `street` |
| `city` | `city` | `city` | `city` |
| `region` | `region` | `region` | `state` |
| `postalCode` | `postal_code` | `postalCode` | `zip` |
| `countryCode` | `country` | `countryCode` | `country` |

### Dates, numbers, enums

| Field | Façade | Backend | Transform |
|---|---|---|---|
| `orderDate` | `2026-09-15` | ERP `doc_date: "20260915"` | insert dashes |
| `requestedDeliveryDate` | `2026-10-05` | ERP `delivery_date: "20261005"` | insert dashes |
| `lastUpdatedAt` | `2026-09-23T14:22:31Z` | ERP `changed_at: "20260923142231"` | reformat (UTC) |
| `orderedQuantity`, `unitPrice` | numbers | ERP `"250.000"`, `"84.50"` | `Number()` |
| `acknowledgedQuantity` | number | ERP `confirmed_qty: "0.000"` | `Number()` |
| `confirmedDeliveryDate` | `2026-10-08` | ERP `confirmed_date: "20261008"` | strip dashes |
| `packages[].packageType` | `PALLET/CARTON/CRATE/OTHER` | TMS `PLT/CTN/CRT/OTH` | lookup |
| `packages[].weightUnit` | `KG/LB` | TMS `weight.unit: kg/lb` | case |
| `packages[].grossWeight` | number | TMS `weight.value` | nest |
| `lines[].shippedQuantity`, `unitOfMeasure` | flat | TMS `quantity.value`, `quantity.uom` | nest |
| `plannedShipAt`, `expectedArrivalAt` | ISO | TMS `schedule.plannedShipDate`, `schedule.estimatedArrival` | nest |

### Status mappings

**PO status** (ERP `status_code` → façade `status`)

| ERP | Text | Façade |
|---|---|---|
| `01` | Open | `OPEN` |
| `02` | Partially confirmed | `PARTIALLY_ACKNOWLEDGED` |
| `03` | Confirmed | `ACKNOWLEDGED` |
| `04` | In delivery | `IN_FULFILLMENT` |
| `05` | Closed | `CLOSED` |
| `09` | Cancelled | `CANCELLED` |

The façade `status` query filter is an array of façade values → map each back to ERP codes and send `status=01,02`.

**Acknowledgement** (façade → ERP `conf_category`, ERP result → façade `status`)

| Façade `acknowledgementType` | ERP `conf_category` | ERP rule |
|---|---|---|
| `ACCEPT` | `AB` | full ordered qty and requested date on every line |
| `ACCEPT_WITH_CHANGES` | `AC` | reduced qty or later date → `IN_REVIEW` |
| `REJECT` | `RJ` | `confirmed_qty` must be 0 |

| ERP result | Façade `status` |
|---|---|
| `conf_category = RJ` | `REJECTED` |
| `status = IN_REVIEW` | `PENDING_REVIEW` |
| `status = POSTED` | `RECORDED` |

**Shipment status** (TMS `milestone.code` → façade `status`)

| TMS | Meaning | Façade |
|---|---|---|
| `PLN` | Planned (created with `tender:false`) | `DRAFT` |
| `TND` | Tendered to carrier | `SUBMITTED` |
| `ITR` | In transit | `IN_TRANSIT` |
| `DLV` | Delivered | `DELIVERED` |
| `EXC` | Exception | `DELAYED` |
| `CXL` | Cancelled | `CANCELLED` |

---

## 2. Authorization (façade 403)

The façade must enforce "which consumer may see/act for which supplier". SRM makes the decision
but **always returns 200** — the iPaaS turns `allowed:false` into a façade error.

```
GET /srm/v1/entitlements/{consumerId}/check?scope=supplier-orders.read&supplierCode=SUP-100245
→ { "allowed": false, "reason": "SUPPLIER_SCOPE_DENIED", "allowedSuppliers": ["SUP-100245"], ... }
```

`consumerId` comes from the façade credential (e.g. the Fusion/Engage application or API key → consumer
mapping). Demo consumers:

| consumerId | Suppliers | Scopes | Notes |
|---|---|---|---|
| `apex-supplier-portal` | SUP-100245 | read, write | happy path |
| `nordwerk-b2b-gateway` | SUP-100311 | read, write | |
| `prc-edi-bridge` | SUP-100402 | read | write → `SCOPE_NOT_GRANTED` |
| `greatlakes-portal` | SUP-100518 | read, write | supplier ON_HOLD → write denied |
| `mmw-legacy-portal` | SUP-100627 | read, write | consumer inactive |
| `jabil-procurement-workbench` | `*` | read | internal app |
| `jabil-ops-console` | `*` | read, write | internal app |

| SRM `reason` | Façade response |
|---|---|
| `OK` | continue |
| `SUPPLIER_SCOPE_DENIED` | 403 `SUPPLIER_SCOPE_DENIED` |
| `SCOPE_NOT_GRANTED`, `CONSUMER_INACTIVE` | 403 `SCOPE_NOT_GRANTED` / `CONSUMER_INACTIVE` |
| `SUPPLIER_BLOCKED`, `SUPPLIER_ON_HOLD` | 403 (or 422) `SUPPLIER_NOT_ACTIVE` |
| `SUPPLIER_NOT_FOUND` | 404 (read) / 422 (write) |

For GET-by-id operations the supplier isn't known up front: fetch the ERP PO (or TMS shipment), resolve
its supplier, **then** check the entitlement, and return 404 (not 403) if you prefer not to leak existence.

---

## 3. Orchestration recipes

### 3.1 `GET /purchase-orders` — aggregation + fan-out

```
1. SRM  GET /entitlements/{consumer}/check?scope=supplier-orders.read[&supplierCode=SUP-…]
2. SRM  GET /vendor-xref?supplierCode=SUP-100245          → erpVendorNumber 0000710245
        (no supplierId filter → use allowedSuppliers; '*' = no vendor filter)
3. ERP  GET /purchase-orders?vendor_id=0000710245&status=01,02&changed_since=…&page=N&limit=M&include=items
4. For each distinct plant    → ERP GET /plants/{plant}          (cache!)
   For each distinct purch_org → ERP GET /reference/purchasing-orgs (cache!)
   For each distinct vendor_id → SRM GET /vendor-xref?erpVendorNumber=a,b,c (batch)
5. Transform each ERP header+items → façade PurchaseOrder
6. Paging: façade pageToken ⇄ ERP page number (e.g. base64("p=2&l=50")); nextPageToken=null when !hasNext
```

`include=items` is optional on purpose: without it the ERP only returns headers + `item_count`, so the
iPaaS must fan out to `GET /purchase-orders/{po}/items` — a nice way to demo parallel for-each.

### 3.2 `GET /purchase-orders/{id}`

```
1. strip "PO-" → ERP GET /purchase-orders/4500123456  (ETag W/"4500123456-r1")
2. SRM GET /vendor-xref/{vendor_id}   → supplierId
3. SRM entitlement check (read) for that supplier
4. ERP GET /plants/{plant} + purchasing org lookup → shipTo, buyingOrganization
5. Transform; pass ETag through
```

### 3.3 `POST /purchase-orders/{id}/acknowledgements`

```
1. Validate Idempotency-Key (required at the façade)
2. ERP  GET /purchase-orders/{po}                     → vendor_id, revision (ETag)
3. SRM  GET /vendor-xref/{vendor_id}                   → supplierCode
4. SRM  entitlement check scope=supplier-orders.write  → 403 if denied
5. ERP  POST /purchase-orders/{po}/confirmations  (If-Match: <ETag>, Idempotency-Key: <key>-erp)
        { conf_category: AB|AC|RJ, vendor_reference, note,
          items: [{ item_no: "00010", confirmed_qty, confirmed_date: "YYYYMMDD", reject_reason }] }
6. Map result → { acknowledgementId, purchaseOrderId: "PO-…", acknowledgementType, supplierReference, status, recordedAt }
   Location: /purchase-orders/{id}/acknowledgements/{acknowledgementId}
```

| ERP error | Façade |
|---|---|
| 409 `CONFIRMATION_EXISTS` | 409 `ACKNOWLEDGEMENT_ALREADY_EXISTS` |
| 412 `REVISION_MISMATCH` | 409 `PURCHASE_ORDER_REVISION_CHANGED` |
| 422 `PO_NOT_CONFIRMABLE` | 422 `PURCHASE_ORDER_NOT_ACKNOWLEDGEABLE` |
| 422 `CONFIRMATION_RULE_VIOLATION` (+`details[]`) | 422 with `violations[]` (map `items[0].confirmed_qty` → `lines[0].acknowledgedQuantity`) |
| 404 `PO_NOT_FOUND` | 404 `PURCHASE_ORDER_NOT_FOUND` |

Demo: PO `4500123456` is open with one line (250 EA). After a successful acknowledgement a second
attempt returns 409. To re-arm, simulate a buyer change: `PATCH /erp/v1/purchase-orders/4500123456 { "delivery_date": "20261012" }` → revision 2.

### 3.4 `POST /shipments` — the saga

```
1. SRM  entitlement check scope=supplier-orders.write&supplierCode=SUP-100245
2. SRM  GET /suppliers/SUP-100245                     → status ACTIVE, capabilities.asn = true
        GET /sites/{shipFrom.siteCode}                → must belong to supplier (enrich address)
3. SRM  GET /vendor-xref?supplierCode=SUP-100245      → vendor 0000710245
4. ERP  GET /purchase-orders?po_number=a,b&include=items  → pre-validate vendor + open_qty (optional; step 7 enforces)
5. ERP  GET /plants?site_code={shipTo.siteCode}      → validate ship-to is a Jabil plant
6. TMS  GET /carriers?code=UPS                        → scac UPSN (422 UNKNOWN_CARRIER otherwise)
7. TMS  POST /shipments                               → SHP-20260924-00200 (TND)
8. ERP  POST /inbound-deliveries { asn_reference: <shipmentId or ASN>, vendor_id, items:[{po_number,item_no,quantity}] }
        reserves shipped qty; 422 SHIPPED_QUANTITY_EXCEEDS_OPEN_QUANTITY if over
   ↳ on failure: TMS POST /shipments/{id}/cancel { reason: "Compensation: …" }   ← compensation
9. Map TMS shipment → façade Shipment (status SUBMITTED, purchaseOrders = distinct "PO-"+poNumber)
```

Alternative ordering (ERP first, then TMS) is also valid; then compensate with
`POST /erp/v1/inbound-deliveries/{deliveryNo}/reverse`. Both compensations exist so you can demo either.

| Backend error | Façade |
|---|---|
| TMS 409 `tms.DUPLICATE_ASN` / ERP 409 `DELIVERY_EXISTS` | 409 `SHIPMENT_NOTICE_ALREADY_EXISTS` |
| ERP 422 `SHIPPED_QUANTITY_EXCEEDS_OPEN_QUANTITY` | 422 same code |
| ERP 422 `DELIVERY_RULE_VIOLATION` (vendor mismatch, closed PO) | 422 `PURCHASE_ORDER_LINE_NOT_SHIPPABLE` |
| TMS 422 `tms.UNKNOWN_CARRIER` | 422 `UNKNOWN_CARRIER` |
| TMS 422 `tms.INVALID_SCHEDULE` | 400 `REQUEST_VALIDATION_FAILED` (violation on `expectedArrivalAt`) |

Failure demos: send `x-mock-status: 503` to the ERP step to force compensation, or set `ERP_ERROR_RATE=0.5`.

### 3.5 `GET /shipments` and `GET /shipments/{id}`

```
list: SRM entitlement (read) → TMS GET /shipments?supplierCode=…&poNumber=…&status=TND,ITR&limit=…&cursor=…
      façade pageToken ⇄ TMS nextCursor (pass through as-is)
get:  TMS GET /shipments/{id} → SRM entitlement check for shipment.supplierCode
map:  carrier.scac → carrierCode (TMS returns both), milestone → status,
      schedule → plannedShipAt/expectedArrivalAt, audit → createdAt/lastUpdatedAt,
      contents → lines (+ "PO-" prefix), handlingUnits → packages, route → shipFrom/shipTo
```

`TMS POST /shipments/{id}/events` is the demo lever: post `EXC` with `newEstimatedArrival` and the
façade status flips to `DELAYED` with a new `expectedArrivalAt`; post `RES` to resume, `DLV` to deliver.

---

## 4. Error normalization → RFC 7807 `ProblemDetails`

| Backend | Error body | Where to find code / fields |
|---|---|---|
| ERP | `{ "error": { code, message, details:[{field,message}], timestamp, correlation_id } }` | `error.code`, `error.details` |
| SRM | `{ "errors": [ { code, message, field? } ], "traceId" }` | `errors[0].code`, `errors[].field` |
| TMS | `{ "fault": { faultCode: "tms.X", faultString, httpStatus, detail:[{path,issue}], correlationId } }` | strip `tms.` prefix, `detail[].path` |

Façade shape: `{ type, title, status, detail, instance, correlationId, timestamp, errorCode, violations[] }`,
content type `application/problem+json`. Map any backend 503 to façade 503
`DOWNSTREAM_SERVICE_UNAVAILABLE` with `Retry-After`.

---

## 5. Seed data cheat-sheet

| PO | Supplier | ERP status | Use it for |
|---|---|---|---|
| 4500123456 | SUP-100245 Apex | 01 Open | acknowledgement + ASN happy path (250 EA MAT-778210, plant 1101) |
| 4500123457 | SUP-100245 Apex | 03 Confirmed | ASN target (2 lines) |
| 4500123458 | SUP-100245 Apex | 04 In delivery (300/500 shipped) | partial shipment; SHP-20260918-00121 in transit |
| 4500123459 | SUP-100245 Apex | 05 Closed | 422 not acknowledgeable / not shippable |
| 4500123467 | SUP-100245 Apex | 01 Open | second open Apex PO (plant 1102) |
| 4500123460, 4500123468 | SUP-100311 Nordwerk | 01 Open | `apex-supplier-portal` → 403 SUPPLIER_SCOPE_DENIED |
| 4500123461 | SUP-100311 Nordwerk | 02 Partially confirmed (confirmation IN_REVIEW) | PARTIALLY_ACKNOWLEDGED / PENDING_REVIEW |
| 4500123462 / 4500123463 | SUP-100402 Pacific Rim | 04 / 01 | read-only consumer `prc-edi-bridge` |
| 4500123464 | SUP-100518 Great Lakes (ON_HOLD) | 01 Open | write denied: supplier on hold |
| 4500123465 | SUP-100627 Monterrey (BLOCKED) | 09 Cancelled | CANCELLED; blocked supplier |
| 4500123466 | SUP-100733 Bharat | 01 Open | list/paging/filters |

| Shipment | Milestone | Façade status |
|---|---|---|
| SHP-20260828-00088 | DLV | DELIVERED |
| SHP-20260915-00107 | EXC (Maersk) | DELAYED |
| SHP-20260918-00121 | ITR (ASN-439901) | IN_TRANSIT |
| SHP-20260922-00188 | PLN (Nordwerk) | DRAFT |

Reset everything at any time: `npm run seed:reset`.
