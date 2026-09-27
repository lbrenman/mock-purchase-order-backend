# Changes in v2.5.0

The façade docs no longer assume a specific implementation product (any integration platform, API gateway or
API framework can implement it), and `package-lock.json` is no longer committed. See `CHANGELOG.md` for the
full description.

## Changed files

| File | Change |
|---|---|
| `.gitignore` | Ignores `package-lock.json` |
| `README.md` | Framework-neutral intro and diagram; *Using the specs in Amplify Fusion* → *Implementing the façade* (contents entry too); Codespaces, ngrok, authentication, façade console, project structure and troubleshooting wording |
| `facade/README.md` | Framework-neutral intro, status-filter rationale, import note, base-address example, CORS and troubleshooting wording |
| `facade/facade-console.html` | Settings hint: "your façade URL" instead of a product-specific proxy URL |
| `docs/MAPPING.md` | Framework-neutral intro; `consumerId` example (API key client application or OAuth client ID) |
| `CLAUDE.md` | Façade implementation is framework-neutral, keep the docs that way |
| `openapi/erp.yaml`, `openapi/srm.yaml`, `openapi/tms.yaml` | Description text: "the façade layer" instead of "the iPaaS" |
| `public/dashboard/js/views/erp.js` | ERP page lede wording |
| `src/shared/middleware.js`, `src/shared/docs.js`, `src/shared/errors.js`, `src/services/srm/routes.js` | Comments only |
| `tools/build-postman.py` | Scenarios folder description and a comment |
| `postman/mock-po-backends.postman_collection.json` | Regenerated; only the Scenarios folder description changed |
| `CHANGELOG.md` | 2.5.0 entry |
| `package.json` | Version 2.5.0; framework-neutral description |
| `CHANGES-v2.5.md` | This file |

## Removed from the repository

| File | Why |
|---|---|
| `package-lock.json` | Now in `.gitignore`. It stays on disk in existing clones and Codespaces; only git stops tracking it. |

## Applying this update

From the repository root, with the changed-files ZIP unpacked into it:

```bash
git rm --cached package-lock.json     # stop tracking it; the local file is kept
git add -A && git commit -m "v2.5.0: framework-neutral façade docs, ignore package-lock.json"
git push
```

No dependency, database or seed changes: no `npm install` or `npm run seed:reset` needed.
