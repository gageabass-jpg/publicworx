# AGENTS.md — TMH Radiology Staff Schedule

## What this is
A static site (no build step) showing the X-ray department's monthly staff schedule. Deployed on Vercel from the repo root. Files are plain HTML + JS — no framework, no bundler.

## Architecture
- `index.html` — desktop schedule grid (renders via `support.js`, a lightweight DC runtime that uses React/ReactDOM from CDN)
- `mobile.html` — mobile calendar/card view (same runtime + data)
- `mobile.html` also has an "Add to calendar" button (header, left of the date-range button). Tapping a name opens a second step: **Subscribe** (a `webcal://` link to `/api/calendar?name=...`, so the phone's calendar updates by itself), **Download Current Schedule** (a one-time `.ics`, from today on), or **Copy link** (for Android / Google Calendar).
- `ics.js` — shared by the mobile page (`window.ScheduleIcs`) and `api/calendar.js`. It builds one person's events with stable IDs (`tmh-<name>-<period start>-<day>@schedule.exchange`), so the download and the feed match. Each event has `LOCATION:` Thomas Memorial Hospital, 4605 MacCorkle Ave SW, South Charleston, WV 25309 (`HOSPITAL` in `ics.js`), except shifts whose note is `SF` (St. Francis / Thomas Orthopedic) or `UC` without `TMH` (University of Charleston). Those are other sites and have no address on file, so they get none. Its `parseCode` is a port of `parseCode` in `mobile.html`; change both together. The mobile page loads it with `<script src="./ics.js">`, so a fresh mobile design export must keep that tag and the button.
- `api/calendar.js` — public feed, `GET /api/calendar?name=Angela%20(T)` (name match ignores case). It reads `schedule-data.js` (`includeFiles` in `vercel.json`), skips approved removals, includes past shifts so the calendar keeps its history, and is cached at the edge for 15 minutes. Errors: 400 no name, 404 unknown name, 405 not GET.
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

## Upload logs
Every `.xlsx` upload in `/admin` (and any other upload with warnings or errors) saves a full, untruncated log. The console does this on its own and shows a "Log saved · view" link on the staged file.
- Where: branch `import-logs` (override with `LOG_BRANCH`), one file per upload at `logs/<timestamp>-<kind>-<id>.json`. The branch is made from `main` on the first log. Logs never touch `main`, so they do not redeploy the site.
- What: file name and size, sheet names, every error and warning, `unknownCells` (period, person, day, raw code for each cell the page cannot read), and the period summary. No grid dump.
- Red fill: the `.xlsx` importer reads each cell's solid fill (SheetJS `cellStyles`). A red-filled shift cell gets the `*` on-call suffix. Off, vacation, holiday and blank cells get none. `isRedFill` in `admin/xlsx-import.js` decides what counts as red. The log holds `fillStats`: every fill colour found (`palette`), how many cells were marked on call, and how many red cells were blank. Check it if a colour is missed. SheetJS reads `indexed` palette colours and font colours as nothing, so those do not count.
- How: `POST /api/schedule?op=log` (password required) in `api/schedule.js`; limit 512 KB per log.
- Privacy: the repo is public, so the logs are public. They hold staff names and shift codes, the same data the public schedule shows.
- Read them with the GitHub tools: list `logs/` on `import-logs`.

## Verification
- `curl localhost:3000/` → desktop schedule HTML (200)
- `curl localhost:3000/mobile.html` → mobile schedule HTML (200)
- `curl localhost:3000/admin/` → admin console HTML (200)
- `curl 'localhost:3000/api/schedule?op=health'` → JSON health check
