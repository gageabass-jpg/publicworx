# TMH Radiology staff schedule

Static site. No build step. `index.html` is the schedule page exported from Claude Design. `support.js` and `_ds/` are its runtime. The site deploys from the `main` branch to Vercel and to GitHub Pages.

Schedule data lives in the `PERIODS` array inside `index.html`.

## Publishing a new copy of the schedule

Open `/admin` on the Vercel site. The console lets you:

- drop in a new export (`X-ray Schedule.dc.html` or `index.html`), see which periods it holds, and preview it;
- publish it. The console commits the file as `index.html` on `main`. Vercel deploys the commit in about a minute;
- restore any earlier copy from the history list.

The console talks to `api/schedule.js`, a Vercel serverless function. The function checks the file and writes it to GitHub. The GitHub token never reaches the browser.

### One-time setup

1. In GitHub, create a fine-grained personal access token. Scope it to this repository with **Contents: Read and write**.
2. In the Vercel project, open **Settings → Environment Variables** and add:

   | Name | Value |
   | --- | --- |
   | `ADMIN_PASSWORD` | the password the console asks for |
   | `GITHUB_TOKEN` | the token from step 1 |

   Optional: `GITHUB_REPO` (`owner/name`), `GITHUB_BRANCH` (default `main`), `SCHEDULE_PATH` (default `index.html`). The defaults come from the repository Vercel is linked to.
3. Redeploy the project. Open `/admin` and sign in.

GitHub Pages serves the same files but has no serverless functions, so the console cannot publish from there.

## Local check

```
node -e "require('./api/schedule.js')"   # loads the function
```

Open `index.html` directly or serve the folder with any static server.
