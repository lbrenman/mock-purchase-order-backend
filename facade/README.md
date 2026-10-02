# Façade

This folder holds the contract the façade layer implements, and a browser console for calling it.

| File | What it is |
|---|---|
| `Supplier_Order_Collaboration_OpenAPI_3_1.yaml` | The Supplier Order Collaboration API (OpenAPI 3.1). Any integration platform, API gateway or API framework can implement it on top of the ERP, SRM and TMS backends. `docs/MAPPING.md` describes the mappings. |
| `facade-console.html` | A single-file web app that calls the façade as one or more consumers. No build step, no dependencies. |

The backend specs are in `openapi/`, not here.

## The spec

### Status filters are comma-separated strings

`status` on `GET /purchase-orders` and `GET /shipments` is a plain string, not an array. Some API platforms
handle array query parameters poorly. Each parameter has:

- `type: string`;
- a pattern listing the allowed values, for example `^(OPEN|CLOSED)(,(OPEN|CLOSED))*$`;
- a description of the allowed values, comma-separated with no spaces;
- an example, such as `OPEN,PARTIALLY_ACKNOWLEDGED` or `IN_TRANSIT,DELAYED`.

There is no `style` or `explode`. Keep any new multi-value filter in the same form.

### Import errors about duplicate proxies

If a platform rejects an import with an error such as *"Cursor returned more than one result"*, it already holds
more than one proxy matching this API. Remove the duplicates, or change `info.title` or bump `info.version`
before importing again. The spec itself is fine.

## The console

`facade-console.html` calls the façade only, never the backends. It covers all six operations:

| Tab | Operations |
|---|---|
| Purchase orders | `GET /purchase-orders`, `GET /purchase-orders/{purchaseOrderId}`, and from an order: **Acknowledge order** (`POST /purchase-orders/{purchaseOrderId}/acknowledgements`) and **Ship this order** (`POST /shipments`) |
| Shipments | `GET /shipments`, `GET /shipments/{shipmentId}`, **New shipment notice** (`POST /shipments`) |
| Activity | Every request the page sent: status, timing, consumer, headers, bodies, correlation IDs, Copy as cURL |
| Settings | API base address, key header name, timeout, correlation IDs, and one consumer per API key or bearer token |

### The consumer lens

The strip at the top of the page shows which consumer every call is made as. Switching consumer and watching
what each one is allowed to see is the point of the demo, so the strip is the largest thing on the page.

- **Who:** the consumer's name, a monogram tile, the credential type (API key and its header, or bearer token,
  or *No key set*), and the note from Settings.
- **What it saw:** three figures for the active consumer:
  - *Orders visible* and *Shipments visible*, the item count of the last list load. `+` means there are more pages.
    *Filtered* means filters were applied. A failed load shows its HTTP status.
  - *Last response*, the status code of the consumer's most recent call, with the `errorCode` when there is one
    (for example `401` and `AUTHENTICATION_REQUIRED`) and the response time.
- **Switching:** each consumer has a pill in its own colour.
  - Selecting one re-colours the strip and reloads the lists and any open order or shipment.
  - Arrow keys move between pills.
  - With more than six consumers the pills give way to a dropdown.
  - With a single consumer, a link suggests adding another one.
- The same colour marks the consumer's row in Settings and the *Sends as* line in the acknowledgement and shipment
  forms.

The figures are kept in memory per consumer and reset when the page reloads. They are never stored.

### Orders and shipments

- **Order detail:** a numbered lifecycle (Open, Partially acknowledged, Acknowledged, In fulfillment, Closed),
  facts, ship-to address, lines with an acknowledged-quantity meter, and the raw response with its correlation ID
  and ETag. Cancelled orders show the lifecycle as halted.
- **Shipment detail:** a route from ship-from to ship-to with the truck positioned by status, carrier and tracking,
  the orders it carries (each opens the order), lines, packages and the raw response.
- **Show shipments for this order** jumps to the Shipments tab filtered by that order.

### Acknowledgements and shipment notices

**Acknowledge order** and **Ship this order** (on an order) and **New shipment notice** (on the Shipments tab) open
a form:

- **Idempotency key:** shown and editable. Sending again with the same key is a retry and should return the
  original result. **New key** makes a separate request.
- **Acknowledge order:** Accept, Accept with changes or Reject. Lines start at the ordered quantity (Reject sets
  them to 0). Each line can carry a confirmed delivery date and a rejection reason, and can be left out.
- **Shipment notice:** prefilled from the order when opened with **Ship this order**. Quantities start at the
  acknowledged quantity, or the ordered quantity when nothing is acknowledged yet. Lines and packages can be added
  and removed; empty rows are left out. The ship-from address is remembered per supplier after a successful notice.
- **Request:** a live preview of the method, path, key and JSON body.
- **Errors:** the ProblemDetails fields are shown at the top, and each entry in `violations` is marked on its field.
- **Success:** the result shows the new IDs, status and `Location` header, with buttons to view the order or open
  the shipment, or go back to the form and send again.

Close a form with **Cancel**, **Close**, Escape or a click outside it.

### Errors

Errors show the ProblemDetails fields: title, detail, `errorCode`, correlation ID, type, instance,
`Retry-After` and `violations`. The console doesn't validate IDs or filters itself, so the façade's own 400
responses show up as they would for any consumer.

## Opening it

Serve the file over HTTP rather than opening it from disk. A page opened from disk sends `Origin: null`,
which is awkward to allow in CORS, and some browsers (Safari especially) restrict storage for local files.

```bash
# from the repository root; Python is preinstalled in the Codespaces image
python3 -m http.server 8080 --directory facade
# then open http://localhost:8080/facade-console.html
# (in a Codespace, open the forwarded port 8080 from the Ports tab)

# or, with Node
npx --yes serve facade -l 8080
```

The first time, the console opens on **Settings**. Enter the base address and at least one consumer, then
**Save settings**.

### On a phone

The console works on a phone. Open the Codespace's forwarded URL, or your machine's LAN address, and allow that
origin in CORS.

- Forms open as a sheet from the bottom of the screen.
- Toasts can be swiped down to dismiss.
- Long tables scroll sideways inside their own box; the page itself doesn't.
- ID fields open with capitals and no autocorrect, and quantity fields bring up a number keypad.
- Pull-to-refresh is turned off, because a reload clears the activity log and the loaded lists.

Browser device emulation doesn't reproduce tap behaviour, input zoom, safe areas or the swipe gesture. Check those
on a real phone.

### Motion and keyboard

- Forms scale in and fade out, toasts rise from the bottom edge, and the shipment truck moves to its position.
  Switching tabs and selecting rows don't animate.
- With *Reduce motion* set in the operating system, the movement is removed and only short fades remain.
- Toasts pause while the pointer is over them and while the tab is hidden.
- Arrow keys, Home and End move between tabs and between consumer pills. Enter or Space opens the focused row.

## What the façade must allow (CORS)

The browser calls the façade directly, so the façade must answer CORS preflights for the origin the page is
served from (for example `http://localhost:8080` or the Codespace's forwarded URL):

| Header | Value |
|---|---|
| `Access-Control-Allow-Origin` | the console's origin (or `*` for a demo) |
| `Access-Control-Allow-Methods` | `GET, POST, OPTIONS` |
| `Access-Control-Allow-Headers` | `X-API-Key` (or your key header), `X-Correlation-Id`, `Authorization`, `Content-Type`, `Idempotency-Key` |
| `Access-Control-Expose-Headers` | `ETag`, `X-Correlation-Id`, `Retry-After`, `Location` |

Without `Access-Control-Expose-Headers` everything still works, but the console can't show the correlation ID the
façade returned, the ETag, `Retry-After` or the `Location` of a new acknowledgement or shipment.

## Where data is kept

| What | Where |
|---|---|
| Settings, including API keys and tokens | localStorage, `soc-console.settings.v1`, in plain text |
| Last ship-from address per supplier | localStorage, `soc-console.shipFrom.v1` |
| Lens figures, activity log (last 150 calls) | Memory only; cleared on reload |

localStorage belongs to the origin the page was loaded from. `http://localhost:8080` and a Codespace's forwarded
URL are separate origins, each with its own settings: use **Export settings** and **Import settings** to copy them
across. Exported files contain the keys in plain text. Private windows and clearing site data remove everything.
Use demo keys, and don't save real keys on a shared computer.

## Troubleshooting

| Symptom | Fix |
|---|---|
| *Can't reach the API* | The browser console shows the reason. Usually CORS: the façade must allow the page's origin and headers (above). Also check the base address and that the façade is deployed. |
| `401 Authentication required` for every consumer | Check that the *API key header* name matches what the façade expects, and that each key is saved. |
| The lens shows `401` right after switching consumer | That consumer's key is missing or wrong. The lens shows *No key set* when the key field is empty. |
| `403` or `404` for one consumer only | Working as designed: that consumer isn't authorized for the supplier or record. |
| `400` on a status filter | Values must be from the spec's list, comma-separated with no spaces. The chips always send a valid list. |
| Activity shows *not readable* for the returned correlation ID | Add `X-Correlation-Id` to `Access-Control-Expose-Headers`. |
| A success shows *No Location header was readable* | Add `Location` to `Access-Control-Expose-Headers`, or the façade doesn't send it. |
| A form's preflight fails but reads work | Add `Content-Type` and `Idempotency-Key` to `Access-Control-Allow-Headers` and `POST` to the allowed methods. |
| `409` on a second send | The same idempotency key was reused against a façade that treats it as a duplicate. Use **New key** for a separate request. |
| Settings vanished | The page was opened from a different origin (port or host), or site data was cleared. Import an exported copy. |
