# Façade

This folder holds the **front-end** side of the demo: the API that Amplify Fusion exposes to consumers, and a
browser app for calling it. The three mock backends behind the façade live in the rest of the repository,
with their own specs in [`../openapi/`](../openapi/).

| File | What it is |
|---|---|
| [`Supplier_Order_Collaboration_OpenAPI_3_1.yaml`](Supplier_Order_Collaboration_OpenAPI_3_1.yaml) | The *Supplier Order Collaboration API* (OpenAPI 3.1). Import it into Fusion and implement it with the recipes in [`../docs/MAPPING.md`](../docs/MAPPING.md). |
| [`facade-console.html`](facade-console.html) | A single-file web app that calls the façade as one of several consumers and shows the results. |

---

## The façade spec

Six operations: list and get purchase orders, acknowledge a purchase order, create an advance shipment
notice, and list and get shipments. Errors are RFC 7807 ProblemDetails.

**Fusion-friendly status filters.** The `status` query parameter on `GET /purchase-orders` and
`GET /shipments` is a plain string holding a comma-separated list, with a pattern that lists the allowed
values, for example:

```yaml
schema:
  type: string
  pattern: '^(OPEN|PARTIALLY_ACKNOWLEDGED|ACKNOWLEDGED|IN_FULFILLMENT|CLOSED|CANCELLED)(,(OPEN|PARTIALLY_ACKNOWLEDGED|ACKNOWLEDGED|IN_FULFILLMENT|CLOSED|CANCELLED))*$'
example: OPEN,PARTIALLY_ACKNOWLEDGED
```

Fusion handles array query parameters poorly, so keep new multi-value filters in this form: `type: string`,
a pattern built from the enum values, no spaces, and no `style` or `explode`. On the wire it is the same as
an array with `style: form, explode: false`, so consumers see no difference.

**Importing into Fusion.** If the import fails with *Failed to update API proxy: Cursor returned more than one
result*, the tenant has more than one proxy matching the same API. Remove the duplicates, or change
`info.title` or bump `info.version` in the spec before importing.

---

## Façade console

`facade-console.html` has everything inline (HTML, CSS, JavaScript). There is no build step and nothing to
install. It loads the Barlow fonts from Google Fonts and falls back to system fonts when offline.

### What it does

- **Settings** tab
  - *API base address*: everything before `/purchase-orders`, for example
    `https://<your-fusion-host>/supplier-collaboration/v1`.
  - *API key header*: the header that carries the key. Default `X-API-Key`, as in the spec.
  - *Timeout* and whether to send an `X-Correlation-Id` (a new UUID per request).
  - *Consumers*: one row per consumer, each with a name, a credential type (API key, or bearer token for
    the OAuth 2.0 client-credentials option), the key or token, and a note. The radio button picks the
    consumer to call as. *Test connection* calls `GET /purchase-orders?pageSize=1` with that row's values,
    before saving.
  - *Save settings* writes everything to the browser's localStorage. *Export settings* and *Import settings*
    move them between browsers or origins as JSON.
- **Purchase orders** tab: filter by supplier, status (chips, sent as a comma-separated list), updated
  since, and page size; page with `nextPageToken`; or open an order by ID. The detail shows the order
  lifecycle, dates, value, ship-to site, lines with acknowledged quantities, and the raw JSON with the
  correlation ID and ETag. *Show shipments for this order* opens the Shipments tab filtered to it.
- **Shipments** tab: filter by purchase order, supplier, status and page size, or open a shipment by ID.
  The detail shows the route from the ship-from to the ship-to site, with the truck placed by status (amber
  when delayed, green when delivered), carrier and tracking number, lines, packages, and links to the orders.
- **Calling as** (in the header): switch consumer. Lists and details already loaded are fetched again with
  the other key, so the same order can return 200 for one consumer and 403 or 404 for another.
- **Activity** tab: every request, newest first, with consumer, status, timing, request headers (keys
  masked), correlation ID sent and returned, ETag and body. *Copy as cURL* copies the request with the real
  key.

Errors show the ProblemDetails fields: title, detail, `errorCode`, correlation ID, type, instance,
`Retry-After` and `violations`. The console doesn't validate IDs or filters itself, so the façade's own 400
responses show up as they would for any consumer.

### Opening it

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
*Save settings*.

### What the façade must allow (CORS)

The browser calls Fusion directly, so the façade proxy must answer CORS preflights for the origin the page is
served from (for example `http://localhost:8080` or the Codespace's forwarded URL):

| Header | Value |
|---|---|
| `Access-Control-Allow-Origin` | the console's origin (or `*` for a demo) |
| `Access-Control-Allow-Methods` | `GET, POST, OPTIONS` |
| `Access-Control-Allow-Headers` | `X-API-Key` (or your key header), `X-Correlation-Id`, `Authorization`, `Content-Type`, `Idempotency-Key` |
| `Access-Control-Expose-Headers` | `ETag`, `X-Correlation-Id`, `Retry-After` |

Without `Access-Control-Expose-Headers` everything still works, but the Activity tab can't show the
correlation ID the façade returned, the ETag or `Retry-After`.

### Where settings are kept

Settings, including keys, live in localStorage under `soc-console.settings.v1`, in plain text, for the
origin the page was loaded from. `http://localhost:8080` and a Codespace's forwarded URL are separate
origins, each with its own settings: use *Export settings* and *Import settings* to copy them across.
Private windows and clearing site data remove them. Use demo keys, and don't save real keys on a shared
computer.

### Troubleshooting

| Symptom | Fix |
|---|---|
| *Can't reach the API* | The browser console shows the reason. Usually CORS: the façade must allow the page's origin and headers (above). Also check the base address and that the proxy is deployed. |
| `401 Authentication required` for every consumer | Check the *API key header* name matches what Fusion expects, and that each key is saved. |
| `403` or `404` for one consumer only | Working as designed: that consumer isn't authorized for the supplier or record. |
| `400` on a status filter | Values must be from the spec's list, comma-separated with no spaces. The chips always send a valid list. |
| Activity shows *not readable* for the returned correlation ID | Add `X-Correlation-Id` to `Access-Control-Expose-Headers`. |
| Settings are gone after a reload | You opened the page from a different address, in a private window, or storage is blocked (a note under *Save settings* says so). Serve it over HTTP and import an exported settings file. |
