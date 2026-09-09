# Live changes (schedule overrides)

The manager's `schedule-data.js` is the baseline schedule and stays the source of
truth. "Live changes" — call-ins, swaps, sick days, on-call moves — are stored
separately as **override records** and layered on top of the baseline when a page
loads. This keeps the baseline safe: a new schedule import re-bases cleanly, and
overrides never edit the manager's file.

## Parts

| File | Role |
| --- | --- |
| `overrides.js` | Shared, dependency-free merge logic. `applyOverrides(periods, overrides)` returns the effective schedule plus per-cell change metadata. Used by the pages and by tests. |
| `api/overrides.js` | Vercel serverless function. Stores overrides and suggestions in Vercel KV. Reading live overrides is public; writing needs the console password. |

## Two tiers

- **Editors** (anyone with the console password) post a change that goes **live
  immediately**, attributed and timestamped.
- **Anyone** can submit a **suggestion** (no login). Suggestions wait in a queue for
  an editor to approve or dismiss. Approving turns a suggestion into a live override.

## Setup — Vercel KV (one-time, by the project owner)

1. In the Vercel project: **Storage → Create Database → KV** (Upstash Redis).
2. Connect it to this project. Vercel adds the environment variables automatically:
   `KV_REST_API_URL`, `KV_REST_API_TOKEN` (and a read-only token).
   `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` are accepted as fallbacks.
3. `ADMIN_PASSWORD` is already set for the console — the editor tier reuses it.
4. **Redeploy.** Check `GET /api/overrides?op=health` → `{ "configured": { "kv": true, "password": true } }`.

Until KV is configured, the API answers `503` and the pages simply show the baseline
schedule with no overrides — nothing breaks.

## API summary

| Method / op | Auth | Purpose |
| --- | --- | --- |
| `GET ?op=health` | public | Configuration check. |
| `GET ?op=live` | public | Live overrides for the pages to layer on. |
| `POST ?op=suggest` | public | Submit a change suggestion (queued). |
| `GET ?op=all` | password | Overrides + pending suggestions (for the console). |
| `POST {op:"save"}` | password | Add or update a live override (one per person·day·period). |
| `POST {op:"remove"}` | password | Remove an override by `id`, or by `periodKey`+`person`+`day`. |
| `POST {op:"resolve"}` | password | `action:"approve"` (→ live override) or `"dismiss"` a suggestion. |

### Override record

```json
{
  "id": "…", "periodKey": "2026-08-30", "section": "Day shift",
  "person": "Heather", "day": 4, "code": "V",
  "reason": "sick", "author": "Lead", "status": "live",
  "createdAt": "…", "updatedAt": "…"
}
```

- `periodKey` = the period's start date, `YYYY-MM-DD` (stable across title edits).
- `day` = 1–28 offset within the period.
- `code` = a cell code (e.g. `3`, `V`, `7a-430p*`), or `null`/empty to clear the day.

## Re-import reconciliation (planned)

When a new baseline is imported, the new schedule wins for any untouched day. Where a
live override and a new baseline value collide, the console flags it for review rather
than silently choosing one. Past-date overrides are dropped. (Wired up with the
SharePoint/XML import.)
