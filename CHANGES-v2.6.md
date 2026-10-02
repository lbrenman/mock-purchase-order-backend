# Changes in v2.6.0

The façade console now covers all six façade operations: forms for acknowledging an order and creating a
shipment notice join the four read views. See `CHANGELOG.md` for the full description.

## Changed files

| File | Change |
|---|---|
| `facade/facade-console.html` | *Acknowledge order* and *Ship this order* on the order detail, *New shipment notice* on the Shipments tab (dialog forms with editable `Idempotency-Key`, request preview, field-level violations, 201 result with `Location`); Activity log shows request bodies and `Location`; *Copy as cURL* includes the body; ship-from remembered per supplier under `soc-console.shipFrom.v1` |
| `facade/README.md` | The two forms, idempotency in the forms, `Location` in the exposed CORS headers, settings storage, new troubleshooting rows |
| `README.md` | *Façade console* section: all six operations, CORS headers |
| `CLAUDE.md` | `facade/` entry: the console covers all six operations |
| `CHANGELOG.md` | 2.6.0 entry |
| `package.json` | Version 2.6.0 |
| `CHANGES-v2.6.md` | This file |

## Applying this update

From the repository root, with the changed-files ZIP unpacked into it:

```bash
git add -A && git commit -m "v2.6.0: façade console covers all six operations"
git push
```

No dependency, database or seed changes: no `npm install` or `npm run seed:reset` needed.

For the forms to work, the façade's CORS settings must allow the `Content-Type` and `Idempotency-Key`
request headers and the `POST` method, and should expose `Location` (see `facade/README.md`).
