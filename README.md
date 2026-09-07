# TMH Radiology staff schedule

Static site — no build step.

- `index.html` — desktop grid. Phones are redirected to `mobile.html` automatically (add `?desktop=1` to force the desktop view).
- `mobile.html` — phone layout (calendar + swipeable Day/Evening/Night cards + Staff list).
- `schedule-data.js` — the schedule itself. Both pages read this; edit only here.
- `support.js`, `_ds/` — runtime + styles.

Commit the folder contents to the repo root; Vercel/GitHub Pages serve it as-is.
