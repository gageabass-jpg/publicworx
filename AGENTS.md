# AGENTS.md — TMH Radiology Staff Schedule

## What this is
A static site (no build step) showing the X-ray department's monthly staff schedule. Deployed on Vercel from the repo root. Files are plain HTML + JS — no framework, no bundler.

## Architecture
- `index.html` — desktop schedule grid (renders via `support.js`, a lightweight DC runtime that uses React/ReactDOM from CDN)
- `mobile.html` — mobile calendar/card view (same runtime + data)
- `brand.html` — brand sheet (standalone)
- `admin/index.html` — admin console for publishing schedule changes to GitHub
- `support.js` — generated DC runtime (do not edit; renders the HTML templates)
- `schedule-data.js` — single source of truth: `export const PERIODS = [...]`
- `_ds/nocturne-*/` — Nocturne design system (styles.css + _ds_bundle.js)
- `api/schedule.js` — Vercel serverless function (Node) backing the admin console; commits to GitHub via the Git Data API
- `admin/inspect.js` — shared validation logic (browser + Node)

## Running in Base44
- `docker compose -f docker-compose.base44.yml up -d` — starts a Node 22 container serving static files + wrapping the API on port 3000
- `server.js` at repo root is the dev server (serves static files, proxies `/api/schedule` to the Vercel handler)
- No build step, no dependencies to install — just `node server.js`
- Live reload: restart the container after editing server.js; static file changes are served immediately on refresh

## Secrets (optional)
The main schedule views need NO credentials. The admin console (`/admin`) needs:
- `ADMIN_PASSWORD` — authenticates POST to `/api/schedule`
- `GITHUB_TOKEN` — fine-grained token with Contents: read+write on `gageabass-jpg/publicworx`
Without these, `/api/schedule?op=health` returns `configured: {password: false, token: false}` and the admin console shows "not configured."

## Verification
- `curl localhost:3000/` → desktop schedule HTML (200)
- `curl localhost:3000/mobile.html` → mobile schedule HTML (200)
- `curl localhost:3000/admin/` → admin console HTML (200)
- `curl 'localhost:3000/api/schedule?op=health'` → JSON health check
