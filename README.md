# publicworx

Static single-page site: **Commonwealth v. Lindsay Clancy — Trial Tracker**.

The page is a self-contained `index.html` (all CSS and JS inlined, no build step,
no external dependencies). It is served as a static site via GitHub Pages.

## How it's set up

- `index.html` — the entire site (tabs, timeline, sources, etc.).
- `.nojekyll` — tells GitHub Pages to serve files as-is (skip Jekyll processing).
- `.github/workflows/deploy-pages.yml` — GitHub Actions workflow that publishes the
  repository root to GitHub Pages on every push to `main`.

## Enable the page (one-time)

The workflow deploys automatically, but Pages must be switched on for the repo first:

1. Go to the repository on GitHub → **Settings** → **Pages**.
2. Under **Build and deployment → Source**, choose **GitHub Actions**.
3. Merge this branch into `main` (or push to `main`). The
   **Deploy to GitHub Pages** workflow runs and publishes the site.
4. The live URL appears in **Settings → Pages** and on the workflow run
   (typically `https://<owner>.github.io/publicworx/`).

You can also trigger a deploy manually from the **Actions** tab
(**Deploy to GitHub Pages → Run workflow**).

## Local preview

Just open `index.html` in a browser, or serve the folder:

```sh
python3 -m http.server 8000
# then visit http://localhost:8000
```

## Editing

- The **Verdict Watch** status block is marked in the HTML between
  `<!-- VERDICT-STATUS:START -->` and `<!-- VERDICT-STATUS:END -->` for quick updates.
- Content records reporting and testimony as claims made in court, not findings of
  fact; verify against live reporting before relying on any detail.
