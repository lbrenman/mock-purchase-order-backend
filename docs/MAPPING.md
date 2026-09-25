# Façade ↔ Backend Mapping Guide

This is the answer key for implementing the **Supplier Order Collaboration API** façade in Amplify Fusion
on top of the three mock backends. The façade spec is [`Supplier_Order_Collaboration_OpenAPI_3_1.yaml`](../Supplier_Order_Collaboration_OpenAPI_3_1.yaml) in the repository
root; the backend specs are in [`openapi/`](../openapi/). Each façade operation needs **two or three backend
calls**: always exactly one SRM call (authorization plus supplier resolution), and one or two calls to
the ERP or TMS. The rest is transformation.

| Backend | Base path | Owns | Dialect |
|---|---|---|---|
| **ERP** (SAP-style purchasing) | `/erp/v1` | Purchase orders and items, confirmations, inbound deliveries | snake_case, `YYYYMMDD` dates, decimals as strings, status codes `01`–`09`, `{data, pagination}` |
| **SRM** (supplier master) | `/srm/v1` | Supplier identity `SUP-xxxxxx`, ERP vendor numbers, consumer entitlements | nested camelCase, `{total, offset, limit, items}` |
| **TMS** (logistics) | `/tms/v1` | Shipments (ASNs), carriers, milestones, tracking events | nested objects, milestone codes, `{count, results, nextCursor}` |

Send to every backend: its `x-api-key`, and the façade's `X-Correlation-Id` (every backend echoes it and
puts it in its errors). On POSTs, derive a per-backend `Idempotency-Key` from the façade key
(`<key>-tms`, `<key>-erp`).

## At a glance

| Façade operation | Backend calls, in order |
|---|---|
| `GET /purchase-orders` | SRM check (read) → ERP list |
| `GET /purchase-orders/{id}` | ERP get → SRM check (read, by vendor) |
| `POST /purchase-orders/{id}/acknowledgements` | ERP get → SRM check (write, by vendor) → ERP confirmation |
| `POST /shipments` | SRM check (write) → TMS create → ERP inbound delivery (on failure: TMS cancel) |
| `GET /shipments` | SRM check (read) → TMS list |
| `GET /shipments/{id}` | TMS get → SRM check (read) |

Every one of these is a runnable folder in the Postman collection under **Scenarios - façade walkthroughs**;
`POST /shipments` has two, the happy path (with a full worked example below) and the compensation path.

### The one SRM call

```
GET /srm/v1/entitlements/{consumerId}/check?scope=supplier-orders.read|write
        [&supplierCode=SUP-100245 | &erpVendorNumber=0000710245]
```

`consumerId` comes from the façade credential (for example the Fusion or Engage application mapped to a
consumer). The answer is always 200 (404 only for an unknown consumer) and contains everything the façade
needs from the SRM:

```json
{
  "allowed": true,
  "reason": "OK",
  "supplierCode": "SUP-100245",
  "supplier": { "supplierCode": "SUP-100245", "erpVendorNumber": "0000710245", "status": "ACTIVE", "asnEnabled": true, "legalName": "..." },
  "allowedSuppliers": ["SUP-100245"],
  "allowedVendors": [ { "supplierCode": "SUP-100245", "erpVendorNumber": "0000710245" } ]
}
```

- Starting from a façade `supplierId`? Pass `supplierCode` and read `supplier.erpVendorNumber`.
- Starting from an ERP purchase order? Pass its `vendor_id` as `erpVendorNumber` and read `supplierCode`.
- Listing? Pass neither. `allowedVendors` lists the vendor numbers to query and maps them back to
  `supplierId`. For consumers with access to every supplier (`allowedSuppliers: ["*"]`) it lists all suppliers.

`allowed: false` becomes a façade error (section 3). `/srm/v1/vendor-xref` still exists for ad-hoc lookups,
but the façade does not need it.

---

## 1. Field mappings

### Identifiers and codes

| Concept | Façade | ERP | TMS | How |
|---|---|---|---|---|
| Purchase order | `PO-4500123456` | `po_number: "4500123456"` | `contents[].poNumber` | add or strip `PO-` (ERP answers 400 `INVALID_PO_NUMBER` to a prefixed id) |
| Line | `lineNumber: 10` | `item_no: "00010"` | `contents[].poLine: 10` | ERP: zero-pad to 5 digits |
| Supplier | `supplierId: SUP-100245` | `vendor_id: "0000710245"` | `supplierCode: SUP-100245` | SRM check (above) |
| Buying org | `buyingOrganization` | `purch_org_name` | — | copy |
| Carrier | `carrierCode: UPS` | — | send `carrier.carrierCode`, read `carrier.carrierCode` | copy (TMS resolves the SCAC itself) |
| ASN number | `shipmentNoticeNumber` | `asn_reference` | `asnNumber` | copy |
| Acknowledgement id | `ACK-20260924-000101` | `confirmation_no: "7100000101"` | — | `ACK-` + `posted_at[0..8]` + `-` + last 6 digits |

### Addresses

| Façade `Address` | ERP `ship_to` (embedded in every PO) | TMS `route.origin` / `route.destination` |
|---|---|---|
| `siteCode` | `site_code` | `locationCode` |
| `name` | `name` | `name` |
| `addressLine1` | `street` | `street` |
| `city` | `city` | `city` |
| `region` | `region` | `state` |
| `postalCode` | `postal_code` | `zip` |
| `countryCode` | `country` | `country` |

### Dates, numbers, nesting

| Façade | Backend | Transform |
|---|---|---|
| `orderDate`, `requestedDeliveryDate`, `confirmedDeliveryDate` | ERP `doc_date`, `delivery_date`, `confirmed_date` (`YYYYMMDD`) | insert or strip dashes |
| `lastUpdatedAt` | ERP `changed_at` (`YYYYMMDDhhmmss`, UTC) | reformat to RFC 3339 |
| `orderedQuantity`, `acknowledgedQuantity`, `unitPrice` | ERP `quantity`, `confirmed_qty`, `net_price` (strings) | `Number()` |
| `description`, `materialId`, `unitOfMeasure` | ERP `short_text`, `material`, `uom` | rename |
| `plannedShipAt`, `expectedArrivalAt` | TMS `schedule.plannedShipDate`, `schedule.estimatedArrival` | nest or flatten |
| `createdAt`, `lastUpdatedAt` (shipment) | TMS `audit.createdAt`, `audit.updatedAt` | flatten |
| `lines[].shippedQuantity`, `unitOfMeasure` | TMS `contents[].quantity.value`, `.uom` | nest or flatten |
| `packages[].packageId`, `packageType`, `grossWeight`, `weightUnit` | TMS `handlingUnits[].huId`, `type`, `weight.value`, `weight.unit` | rename; `PALLET/CARTON/CRATE/OTHER` ↔ `PLT/CTN/CRT/OTH`; `KG/LB` ↔ `kg/lb` |
| `purchaseOrders` | TMS `contents[].poNumber` | distinct values, `PO-` prefix |

### Status codes

| ERP `status_code` | Façade PO `status` | | TMS `milestone.code` | Façade shipment `status` |
|---|---|---|---|---|
| `01` Open | `OPEN` | | `PLN` planned | `DRAFT` |
| `02` Partially confirmed | `PARTIALLY_ACKNOWLEDGED` | | `TND` tendered | `SUBMITTED` |
| `03` Confirmed | `ACKNOWLEDGED` | | `ITR` in transit | `IN_TRANSIT` |
| `04` In delivery | `IN_FULFILLMENT` | | `DLV` delivered | `DELIVERED` |
| `05` Closed | `CLOSED` | | `EXC` exception | `DELAYED` |
| `09` Cancelled | `CANCELLED` | | `CXL` cancelled | `CANCELLED` |

Status filters are arrays in the façade: map each value and join with commas (`status=01,02`, `status=ITR,EXC`).

| Façade `acknowledgementType` | ERP `conf_category` | ERP result | Façade acknowledgement `status` |
|---|---|---|---|
| `ACCEPT` | `AB` (full quantity, requested date) | `POSTED` | `RECORDED` |
| `ACCEPT_WITH_CHANGES` | `AC` (less quantity or a later date goes to review) | `IN_REVIEW` or `POSTED` | `PENDING_REVIEW` or `RECORDED` |
| `REJECT` | `RJ` (`confirmed_qty` must be 0) | `POSTED`, category `RJ` | `REJECTED` |

---

## 2. Recipes

### `GET /purchase-orders`

```
1. SRM  GET /entitlements/{consumer}/check?scope=supplier-orders.read[&supplierCode={supplierId}]
        allowed=false -> 403.  Vendors = supplier.erpVendorNumber, or every allowedVendors[].erpVendorNumber
2. ERP  GET /purchase-orders?vendor_id=<vendors, comma separated>&status=01,02&changed_since=<updatedSince>&page=N&limit=M
        (leave vendor_id out for '*' consumers)
3. Map each entry. supplierId comes from allowedVendors. Items, ship_to and purch_org_name are already there.
   Paging: pageToken <-> ERP page (for example base64("p=2")); nextPageToken = null when pagination.hasNext is false.
```

### `GET /purchase-orders/{purchaseOrderId}`

```
1. ERP  GET /purchase-orders/4500123456                                 404 -> 404 PURCHASE_ORDER_NOT_FOUND
2. SRM  GET /entitlements/{consumer}/check?scope=supplier-orders.read&erpVendorNumber={vendor_id}
        allowed=false -> 403 (or 404 if you prefer not to reveal that the order exists)
3. Map; supplierId = supplierCode from step 2. Pass the ERP ETag through.
```

### `POST /purchase-orders/{purchaseOrderId}/acknowledgements`

```
1. Require Idempotency-Key at the façade.
2. ERP  GET /purchase-orders/{po}                                        -> vendor_id, ETag
3. SRM  GET /entitlements/{consumer}/check?scope=supplier-orders.write&erpVendorNumber={vendor_id}
4. ERP  POST /purchase-orders/{po}/confirmations   (If-Match: <ETag> optional, Idempotency-Key: <key>-erp)
        { conf_category, vendor_reference, note,
          items: [{ item_no: "00010", confirmed_qty, confirmed_date: "YYYYMMDD", reject_reason }] }
5. Respond 201 { acknowledgementId, purchaseOrderId, acknowledgementType, supplierReference, status, recordedAt }
```

To acknowledge the same PO again in a demo, simulate a buyer change so a new revision exists:
`PATCH /erp/v1/purchase-orders/4500123456 {"delivery_date": "20261012"}`.

### `POST /shipments` (saga with compensation)

```
1. SRM  GET /entitlements/{consumer}/check?scope=supplier-orders.write&supplierCode={supplierId}
        allowed=false -> 403;  supplier.asnEnabled=false -> 422 ASN_NOT_ENABLED;  keep supplier.erpVendorNumber
2. TMS  POST /shipments   { asnNumber, supplierCode, carrier: { carrierCode, trackingId }, route, schedule,
                            contents, handlingUnits, tender: true }          -> shipmentId, milestone TND
3. ERP  POST /inbound-deliveries  { asn_reference: shipmentNoticeNumber, vendor_id,
                                    items: [{ po_number, item_no, quantity }] }
        Reserves open quantity and checks vendor and PO status.
   On any failure in step 3:
        TMS POST /shipments/{shipmentId}/cancel { reason: "Compensation: ..." }
        and return the step-3 error (mapped as in section 4).
4. Respond 201 with the mapped TMS shipment (status SUBMITTED).
```

A cancelled shipment frees its ASN number, so the client can retry the same ASN. Ways to demo a
failure: send `x-mock-status: 503` on step 3, set `ERP_ERROR_RATE=0.5`, or ship more than the open
quantity (ERP 422). `POST /erp/v1/inbound-deliveries/{deliveryNo}/reverse` exists if you prefer an
ERP-first saga.

#### Worked example: `POST /shipments`

Runnable as the Postman scenario **4. Create an ASN (POST /shipments)**. One ASN covering two purchase
orders, consumer `apex-supplier-portal`.

**Façade request**

```json
{
  "supplierId": "SUP-100245",
  "shipmentNoticeNumber": "ASN-440882",
  "carrierCode": "UPS",
  "trackingNumber": "1Z999AA10123456784",
  "shipFrom": { "siteCode": "SUP-ATL-01", "name": "Supplier Distribution Center", "city": "Atlanta", "region": "GA", "postalCode": "30301", "countryCode": "US" },
  "shipTo": { "siteCode": "US-AUBURN-HILLS", "name": "Manufacturing Site", "addressLine1": "100 Manufacturing Way", "city": "Auburn Hills", "region": "MI", "postalCode": "48326", "countryCode": "US" },
  "plannedShipAt": "2026-10-03T12:00:00Z",
  "expectedArrivalAt": "2026-10-07T15:00:00Z",
  "lines": [
    { "purchaseOrderId": "PO-4500123456", "lineNumber": 10, "shippedQuantity": 50, "unitOfMeasure": "EA", "lotNumber": "LOT-88291" },
    { "purchaseOrderId": "PO-4500123467", "lineNumber": 20, "shippedQuantity": 120, "unitOfMeasure": "EA", "lotNumber": "LOT-88292" }
  ],
  "packages": [ { "packageId": "PALLET-1001", "packageType": "PALLET", "grossWeight": 240, "weightUnit": "KG" } ]
}
```

**Step 1: SRM.** `GET /srm/v1/entitlements/apex-supplier-portal/check?scope=supplier-orders.write&supplierCode=SUP-100245`
answers `allowed: true` and `supplier: { erpVendorNumber: "0000710245", asnEnabled: true }`.

**Step 2: TMS.** `POST /tms/v1/shipments`

```json
{
  "asnNumber": "ASN-440882",
  "supplierCode": "SUP-100245",
  "carrier": { "carrierCode": "UPS", "trackingId": "1Z999AA10123456784" },
  "route": {
    "origin": { "locationCode": "SUP-ATL-01", "name": "Supplier Distribution Center", "city": "Atlanta", "state": "GA", "zip": "30301", "country": "US" },
    "destination": { "locationCode": "US-AUBURN-HILLS", "name": "Manufacturing Site", "street": "100 Manufacturing Way", "city": "Auburn Hills", "state": "MI", "zip": "48326", "country": "US" }
  },
  "schedule": { "plannedShipDate": "2026-10-03T12:00:00Z", "estimatedArrival": "2026-10-07T15:00:00Z" },
  "contents": [
    { "poNumber": "4500123456", "poLine": 10, "quantity": { "value": 50, "uom": "EA" }, "lotNumber": "LOT-88291" },
    { "poNumber": "4500123467", "poLine": 20, "quantity": { "value": 120, "uom": "EA" }, "lotNumber": "LOT-88292" }
  ],
  "handlingUnits": [ { "huId": "PALLET-1001", "type": "PLT", "weight": { "value": 240, "unit": "kg" } } ],
  "tender": true
}
```

The answer is the shipment with `shipmentId: "SHP-20260924-00205"`, `milestone.code: "TND"` and
`carrier.scac: "UPSN"`. Keep it for the response.

**Step 3: ERP.** `POST /erp/v1/inbound-deliveries`

```json
{
  "asn_reference": "ASN-440882",
  "vendor_id": "0000710245",
  "items": [
    { "po_number": "4500123456", "item_no": "00010", "quantity": 50 },
    { "po_number": "4500123467", "item_no": "00020", "quantity": 120 }
  ]
}
```

A 201 means the quantities are reserved. Any error here triggers `POST /tms/v1/shipments/SHP-20260924-00205/cancel`
before the façade answers.

**Façade response** `201 Created`, `Location: /shipments/SHP-20260924-00205`, built from the step 2 answer:

```json
{
  "shipmentId": "SHP-20260924-00205",
  "supplierId": "SUP-100245",
  "shipmentNoticeNumber": "ASN-440882",
  "carrierCode": "UPS",
  "trackingNumber": "1Z999AA10123456784",
  "shipFrom": { "siteCode": "SUP-ATL-01", "name": "Supplier Distribution Center", "city": "Atlanta", "region": "GA", "postalCode": "30301", "countryCode": "US" },
  "shipTo": { "siteCode": "US-AUBURN-HILLS", "name": "Manufacturing Site", "addressLine1": "100 Manufacturing Way", "city": "Auburn Hills", "region": "MI", "postalCode": "48326", "countryCode": "US" },
  "plannedShipAt": "2026-10-03T12:00:00.000Z",
  "expectedArrivalAt": "2026-10-07T15:00:00.000Z",
  "lines": [
    { "purchaseOrderId": "PO-4500123456", "lineNumber": 10, "shippedQuantity": 50, "unitOfMeasure": "EA", "lotNumber": "LOT-88291" },
    { "purchaseOrderId": "PO-4500123467", "lineNumber": 20, "shippedQuantity": 120, "unitOfMeasure": "EA", "lotNumber": "LOT-88292" }
  ],
  "packages": [ { "packageId": "PALLET-1001", "packageType": "PALLET", "grossWeight": 240, "weightUnit": "KG" } ],
  "status": "SUBMITTED",
  "purchaseOrders": ["PO-4500123456", "PO-4500123467"],
  "createdAt": "2026-09-24T16:55:00.000Z",
  "lastUpdatedAt": "2026-09-24T16:55:00.000Z"
}
```

Mapping points worth showing in the demo: `PO-` stripped on the way in and added back on the way out,
`lineNumber` 20 becoming ERP `item_no` `"00020"`, `PALLET`/`KG` becoming `PLT`/`kg` and back, milestone
`TND` becoming status `SUBMITTED`, drop `null` fields such as the missing `shipFrom.addressLine1`,
and `purchaseOrders` derived as the distinct POs of the lines.

### `GET /shipments` and `GET /shipments/{shipmentId}`

```
list: SRM check (read) -> TMS GET /shipments?supplierCode=<allowed codes>&poNumber=<without PO->&status=TND,ITR&limit=N&cursor=<pageToken>
      nextPageToken = nextCursor (pass through as is)
get:  TMS GET /shipments/{id} -> SRM check (read) with supplierCode = shipment.supplierCode
```

`POST /tms/v1/shipments/{id}/events` is the demo lever: `EXC` with `newEstimatedArrival` turns the
façade status to `DELAYED` with a new `expectedArrivalAt`; `RES` resumes; `DLV` delivers.

---

## 3. Authorization results

| SRM `reason` | Façade response |
|---|---|
| `OK` | continue |
| `SUPPLIER_SCOPE_DENIED` | 403 `SUPPLIER_SCOPE_DENIED` |
| `SCOPE_NOT_GRANTED`, `CONSUMER_INACTIVE` | 403 with the same code |
| `SUPPLIER_ON_HOLD`, `SUPPLIER_BLOCKED` (write only) | 403 `SUPPLIER_NOT_ACTIVE` |
| `SUPPLIER_NOT_FOUND` | 404 on reads, 422 on writes |

---

## 4. Errors → RFC 7807 `ProblemDetails`

| Backend | Error body | Code and fields |
|---|---|---|
| ERP | `{ "error": { code, message, details:[{field,message}], timestamp, correlation_id } }` | `error.code`, `error.details[]` |
| SRM | `{ "errors": [ { code, message, field? } ], "traceId" }` | `errors[0].code`, `errors[].field` |
| TMS | `{ "fault": { faultCode: "tms.X", faultString, httpStatus, detail:[{path,issue}], correlationId } }` | strip `tms.`, `detail[].path` |

Façade body: `{ type, title, status, detail, instance, correlationId, timestamp, errorCode, violations[] }`,
content type `application/problem+json`.

| Backend error | Façade |
|---|---|
| ERP 404 `PO_NOT_FOUND`, TMS 404 `SHIPMENT_NOT_FOUND` | 404 `PURCHASE_ORDER_NOT_FOUND` / `SHIPMENT_NOT_FOUND` |
| ERP 409 `CONFIRMATION_EXISTS` | 409 `ACKNOWLEDGEMENT_ALREADY_EXISTS` |
| ERP 412 `REVISION_MISMATCH` | 409 `PURCHASE_ORDER_REVISION_CHANGED` |
| ERP 422 `PO_NOT_CONFIRMABLE` | 422 `PURCHASE_ORDER_NOT_ACKNOWLEDGEABLE` |
| ERP 422 `CONFIRMATION_RULE_VIOLATION` | 422 with `violations[]` (`items[0].confirmed_qty` → `lines[0].acknowledgedQuantity`) |
| TMS 409 `tms.DUPLICATE_ASN`, ERP 409 `DELIVERY_EXISTS` | 409 `SHIPMENT_NOTICE_ALREADY_EXISTS` |
| ERP 422 `SHIPPED_QUANTITY_EXCEEDS_OPEN_QUANTITY` | 422, same code |
| ERP 422 `DELIVERY_RULE_VIOLATION` | 422 `PURCHASE_ORDER_LINE_NOT_SHIPPABLE` |
| TMS 422 `tms.UNKNOWN_CARRIER` | 422 `UNKNOWN_CARRIER` |
| TMS 422 `tms.INVALID_SCHEDULE` | 400 `REQUEST_VALIDATION_FAILED` (violation on `expectedArrivalAt`) |
| any 400 `VALIDATION_FAILED` | 400 `REQUEST_VALIDATION_FAILED` with mapped field names |
| any 503 | 503 `DOWNSTREAM_SERVICE_UNAVAILABLE` with `Retry-After` |

---

## 5. Seed data cheat-sheet

**Consumers**

| consumerId | Suppliers | Scopes | Notes |
|---|---|---|---|
| `apex-supplier-portal` | SUP-100245 | read, write | happy path |
| `nordwerk-b2b-gateway` | SUP-100311 | read, write | |
| `prc-edi-bridge` | SUP-100402 | read | write → `SCOPE_NOT_GRANTED` |
| `greatlakes-portal` | SUP-100518 | read, write | supplier on hold → write denied |
| `mmw-legacy-portal` | SUP-100627 | read, write | consumer inactive |
| `asia-pacific-edi-network`, `europe-supplier-hub`, `americas-supplier-portal` | three each | read, write | one consumer, several suppliers |
| `acme-procurement-workbench`, `acme-logistics-control-tower`, `acme-spend-analytics`, `acme-l2-support-desk` | `*` | read | internal applications |
| `acme-ops-console` | `*` | read, write | internal application |
| `tristar-portal`, `rm-sensorik-onboarding` | one each | | inactive |

**Purchase orders**

| PO | Supplier | ERP status | Use it for |
|---|---|---|---|
| 4500123456 | SUP-100245 Apex | 01 Open | acknowledgement and ASN happy path (250 EA, plant 1101) |
| 4500123457 | SUP-100245 Apex | 03 Confirmed | ASN target (2 lines) |
| 4500123458 | SUP-100245 Apex | 04 In delivery (300 of 500 shipped) | partial shipment; SHP-20260918-00121 in transit |
| 4500123459 | SUP-100245 Apex | 05 Closed | 422 not acknowledgeable or shippable |
| 4500123467 | SUP-100245 Apex | 01 Open | second open Apex PO (plant 1102) |
| 4500123460, 4500123468 | SUP-100311 Nordwerk | 01 Open | `apex-supplier-portal` → 403 `SUPPLIER_SCOPE_DENIED` |
| 4500123461 | SUP-100311 Nordwerk | 02 (confirmation `IN_REVIEW`) | `PARTIALLY_ACKNOWLEDGED` / `PENDING_REVIEW` |
| 4500123462 / 4500123463 | SUP-100402 Pacific Rim | 04 / 01 | read-only consumer `prc-edi-bridge` |
| 4500123464 | SUP-100518 Great Lakes (on hold) | 01 Open | write denied |
| 4500123465 | SUP-100627 Monterrey (blocked) | 09 Cancelled | `CANCELLED`, blocked supplier |
| 4500123466 | SUP-100733 Bharat | 01 Open | list, paging, filters |
| 4500123471 | AMCN, CNY | 01 Open | supplier rejection (`RJ`) while still open |

**Shipments**

| Shipment | Milestone | Façade status |
|---|---|---|
| SHP-20260828-00088 | DLV | DELIVERED |
| SHP-20260915-00107 | EXC (Maersk) | DELAYED |
| SHP-20260918-00121 | ITR (ASN-439901) | IN_TRANSIT |
| SHP-20260922-00188 | PLN (Nordwerk) | DRAFT |
| SHP-20260923-00131, -00132, -00152 | CXL, with reversed deliveries | CANCELLED (completed compensations) |
| SHP-20260923-00140, -00142, -00145, -00155, -00157 | PLN | DRAFT |

More: suppliers SUP-100917 (on hold), SUP-100951 (blocked), SUP-100938 (conditional, high risk) and
SUP-100996 (no orders yet); POs in EUR, PLN and CNY; 12 carriers.

Totals: 23 suppliers, 74 POs, 54 confirmations, 34 inbound deliveries, 40 shipments, 137 tracking events.
Browse them in the dashboard at `/dashboard/`. Reset with `npm run seed:reset`.
