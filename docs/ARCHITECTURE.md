# Architecture Overview

## Runtime Variants

- `Desktop app`: `apps/desktop/main.py` starts the embedded HTTP server and opens the web UI inside PyWebView.
- `Web app`: static `apps/web/index.html` + `apps/web/app.js`. It prefers the HTTP API and falls back to `apps/web/web_backend.js` when no backend is available.

Both variants share the same frontend UI logic (`apps/web/app.js`) and API contract.

## Layering

- `UI layer`: `apps/web/index.html`, `apps/web/styles.css`, rendering + interaction in `apps/web/app.js`.
- `Service/API layer`: `apps/server/server.py` (HTTP routing, request validation, static serving).
- `Domain layer`:
  - Backend: `apps/server/domain.py` (dataset type/family normalization and canonical mapping).
  - Frontend: `apps/web/domain.js` (shared dataset-domain helpers used by both `app.js` and `web_backend.js`).
- `Data access / adapters`: `apps/server/datasets.py` and `apps/server/profiles.py`.
- `Web fallback adapter`: `apps/web/web_backend.js` emulates backend API shape for browser-only mode.

## Core Principles

- Keep frontend behavior API-driven; fallback mode must follow the same response contract.
- Keep dataset taxonomy logic centralized (type aliases, family mapping, capabilities defaults).
- Keep adapter-specific parsing in backend adapters; avoid UI-embedded schema assumptions.
- Keep API route validation strict for path-derived identifiers to avoid traversal issues.
