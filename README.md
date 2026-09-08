# TMH Radiology staff schedule

Static site. No build step. The `main` branch deploys to Vercel.

- `index.html` — desktop grid. Phones are redirected to `mobile.html` (add `?desktop=1` to force the desktop view).
- `mobile.html` — phone layout.
- `schedule-data.js` — the schedule itself. Both pages import it. This is the only file that changes for a new schedule.
- `support.js`, `_ds/` — runtime and design-system styles.
- `admin/` + `api/schedule.js` — the publishing console (below).
- `HANDOFF.md` — design handoff notes: data model, screens, tokens.

## Publishing a new schedule

Open `/admin` on the Vercel site and sign in. Drop in:

- `schedule-data.js` for a new schedule period. The console runs the file, checks every cell code and date, and lists the periods it found.
- `X-ray Schedule.dc.html` or `X-ray Schedule Mobile.dc.html` (raw exports from Claude Design) for a design change. The console fixes the cross-links and adds the analytics and phone-redirect scripts, the same as the deploy copies.

Preview shows the uploaded files with the runtime already on the site. Publish commits all staged files to `main` in one commit. Vercel deploys in about a minute. History lists recent commits and can restore every schedule file to an earlier commit.

The console talks to `api/schedule.js`, a Vercel serverless function. The GitHub token never reaches the browser.

### One-time setup

1. In GitHub, create a fine-grained personal access token scoped to this repository with **Contents: Read and write**.
2. In the Vercel project, open **Settings → Environment Variables** and add:

   | Name | Value |
   | --- | --- |
   | `ADMIN_PASSWORD` | the password the console asks for |
   | `GITHUB_TOKEN` | the token from step 1 |

   Optional: `GITHUB_REPO` (`owner/name`), `GITHUB_BRANCH` (default `main`), `SCHEDULE_DATA_PATH`, `DESKTOP_PAGE_PATH`, `MOBILE_PAGE_PATH`.
3. Redeploy. Open `/admin` and sign in.
4. Enable Web Analytics in the Vercel dashboard (project → Analytics → Enable). The pages already carry the script tag.

## Editing the schedule by hand

`schedule-data.js` exports `PERIODS`. Each period is 28 days from a Sunday. Cells are `offset:code` pairs; see the comment at the top of the file and `HANDOFF.md` for the code table. Commit to `main` or publish through the console.
