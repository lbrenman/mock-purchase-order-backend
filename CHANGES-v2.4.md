# Changes in v2.4.0

The façade spec and a new browser console for the façade now live in `facade/`. See `CHANGELOG.md` for the
full description.

## Moved

| From | To |
|---|---|
| `Supplier_Order_Collaboration_OpenAPI_3_1.yaml` | `facade/Supplier_Order_Collaboration_OpenAPI_3_1.yaml` (content unchanged) |

Use `git mv` so the file keeps its history (see *Applying this update* below).

## New files

| File | Purpose |
|---|---|
| `facade/facade-console.html` | Single-file web app for calling the façade: settings with per-consumer API keys, order and shipment views, activity log |
| `facade/README.md` | Spec notes, opening the console, CORS the façade must allow, troubleshooting |
| `CHANGES-v2.4.md` | This file |

## Changed files

| File | Change |
|---|---|
| `README.md` | Façade spec links point to `facade/`; new *Façade console* section and contents entry; status-filter and duplicate-proxy notes in *Using the specs in Amplify Fusion*; project structure |
| `docs/MAPPING.md` | Façade spec link; status filters described as comma-separated strings |
| `CLAUDE.md` | Façade spec path; `facade/` in *Where things are* |
| `CHANGELOG.md` | 2.4.0 entry |
| `package.json` | Version 2.4.0 |
| `package-lock.json` | Root version 2.4.0 (it still said 2.2.3) |

## Applying this update

From the repository root, with the changed-files ZIP unpacked into it:

```bash
git mv Supplier_Order_Collaboration_OpenAPI_3_1.yaml facade/
# then copy the unpacked files over the working tree (the ZIP's facade/ spec is identical to the moved one)
git add -A && git commit -m "v2.4.0: facade/ folder with spec and façade console"
```

No dependency, database or seed changes: no `npm install` or `npm run seed:reset` needed.
