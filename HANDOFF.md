# Handoff: TMH Radiology Staff Schedule

## Overview
A web view of the X-ray department's monthly staff schedule, transcribed from paper schedules. Desktop shows a staff × days grid with per-day "who's on" cards, coverage checks, hours totals and a comment form; mobile shows a calendar, swipeable Day/Evening/Night cards and a Staff list. Deployed as a static site on Vercel from the `gageabass-jpg/publicworx` repo (files at repo root). Long-term goal: a scheduling program built on this data model.

## About the design files
Files in `design/` are **design references written in HTML** (a lightweight component runtime, `support.js`, renders them). They show intended look and behavior. The `deploy/` folder is the exact set currently live on Vercel — it works as-is with no build step. Either keep shipping the static files, or recreate the design in a proper framework (Next.js on Vercel is the natural fit) when scheduling features start.

## Fidelity
**High-fidelity.** Colors, type, spacing and interactions are final. Follow the Nocturne design system (`design/_ds/…/styles.css`, `readme.md`): dark ground, Inter 400–600, 8px radii, outlined accent buttons, one accent (#9184d9) used as lines/glows, never floods.

## Immediate to-dos (infra, not design)
1. **Commit + push** the contents of `deploy/` to the repo root on `main` (the user has been uploading by hand). Delete the stray `schedule/schedule/` folder in the repo. Then every future change is one push.
2. **Vercel Web Analytics**: script tags are in both pages; Analytics still needs to be **enabled in the Vercel dashboard** (project → Analytics → Enable). `/_vercel/insights/script.js` currently 404s, which confirms it's off.
3. Optional: `vercel.json` with clean URLs / a `/schedule` → `/` redirect.

## Data model (`schedule-data.js`)
Single source of truth for both pages. `export const PERIODS = [ { label, title, start: [year, monthIndex, day], sections: [ [sectionName, [ [personName, cellString, optionalNote], … ]], … ] }, … ]`.
- A period is 28 days starting on a Sunday (`start` = first day; weeks Sun–Sat).
- `cellString` = comma-separated `offset:code`; offset 1 = first day of the period.
- Codes: `7` = 7a–7:30p · `(7)` / `(8)` = same shift shown in parentheses on paper · `8` = 8a–4:30p · `3` = 3p–11:30p · `11` = 11p–7:30a · explicit ranges like `7a-430p`, `6a-230p`, `9p-730a`, `2-1130p` (missing meridiem inherited from the end time) · `/` = requested off · `V` = vacation · `H` = holiday · trailing text is a note (`8-12 TMH UC`, `SF 8-12`).
- Suffix `*` = **on call** (red cell; stays over for call-ins) · suffix `~` = pen edit on the paper original.
- Per-person exceptions already baked into the data: Lora, Lisa, Bailey, Rachel, Christy — a bare "7" means 7a–4:30p (stored as explicit `7a-430p`). Donnie is a traveler; contract ended 9/12 (note field).
- Shift type derived from start time: < 10:00 → Day, < 18:00 → Evening, else Night.
- Glossary: TMH = Thomas Memorial Hospital (main campus); SF = St. Francis / Thomas Orthopedic; UC = University of Charleston (Shelby's classroom days — she's a clinical instructor).
- Coverage minimums (tweakable props): Day 5, Evening 2, Night 2.
- On-call assignment rule (not yet modeled): staff ranked by overtime picked up; least overtime is called first.

## Screens

### Desktop — `index.html` (`design/X-ray Schedule.dc.html`)
Page: bg #161826, text #e9e9ed, Inter 13px base, padding 22px 24px 40px, `html { zoom: 0.875 }` (tuned so work displays look right at browser 100%). Fixed phone icon (34×34, top-right) links to mobile.html; phones auto-redirect to mobile.html via a small inline script (`?desktop=1` forces desktop for the session).
1. **Header**: kicker "TMH Radiology | Staff Schedule" (20px uppercase, #9397ab); period title as a **dropdown button** (24px/500, ▼ chevron) listing periods with ✓ on the active one.
2. **On-shift block**: date tile (64×64, gradient #2b2741→#232532, month kicker + day number 30px), weekday 24px, "N scheduled", "Today" pill (accent) when on today, "Back to today" button otherwise. Right: **"Fade past days" switch** (44×24 track, accent when on; default on) dims columns before today to 32% opacity. Below: three cards (grid 3 cols, gap 12) — Day / Evening / Night — bg #232532, 1px #3f424d ring, 3px colored top border, count 24px in shift color, people as chips (name + time) in the shift tint; on-call chips red (`oklch(0.48 0.16 25)` / text `oklch(0.97 0.02 25)`) with an "ON CALL" tag.
3. **Grid**: sticky header + sticky 172px name column; day columns `repeat(28, minmax(38px, 1fr))`; week boundaries = 1px #3f424d left borders; selected column tinted #2b2741. Click a date to select (again to return to today; today has a 4px accent dot). Rows grouped by section (Day shift / Evening shift / Midnight shift / PRN) with uppercase accent labels (#b5abfc). Person row: name 12.5px/500 + 3px day/evening/night hours balance bar (110px); cells 30px min-height, radius 4, tint bg `oklch(0.36 0.07 H)` / text `oklch(0.92 0.06 H)`, hues Day 75 / Evening 289 / Night 205; label = start/end on two lines (or codes via prop); on call = red fill; vacation = dashed #75798c border + "V"; holiday "H"; requested off "–". Tooltip = name · date · times · hours · notes. **Click a name** to focus (other rows 28% opacity + 1.2px blur); ctrl/⌘/shift-click adds people to compare; click the only focused name to clear.
   - **Hours columns** (W1–W4 + total) collapsed by default; a tiny «/» button in the grid's top-right corner toggles them.
   - **VACANCIES** (collapsed by default, ▶ chevron): collapsed label shows green ✓ or amber "⚠ N" (total days below minimum); expanded, one row per shift type with headcount per day, cells below min filled `oklch(0.42 0.1 25)`, ✓ / ⚠ N at row right.
4. **Legend** (bottom): Day / Evening / Night swatches, Vacation (dashed), Holiday (H), Requested off (–), On call (red), Pen edit (accent outline), Below minimum coverage. 16.5px text, 14px swatches.
5. **Comments**: fixed round chat-bubble button (52px, bottom-right, accent outline). Opens a centered dialog over a blurred backdrop (`rgba(22,24,38,0.55)` + `backdrop-filter: blur(8px)`): title "Comments & requests", textarea (placeholder "Corrections to the schedule, suggested changes…"), name input (remembered in localStorage `tmh-comment-author`), "Send". Submit POSTs JSON `{name, message, regarding, _subject}` to **Formspree** `https://formspree.io/f/moeqkzvq` (→ gage.a.bass@gmail.com); shows "Sent — thank you." then closes after 1.4s; failure shows amber error. Blank form id falls back to `mailto:`. ⌘/Ctrl+Enter sends, Esc closes.
6. **Analytics**: `window.va` shim + `<script defer src="/_vercel/insights/script.js">`.

### Mobile — `mobile.html` (`design/X-ray Schedule Mobile.dc.html`)
Apple-flavored take on the same data: bg #12131c, text #f2f2f7, system font stack (-apple-system, SF Pro, Inter), max-width 560, translucent surfaces `rgba(255,255,255,0.06)`, 18–22px radii, pill counters, `.press` scale-down on tap.
1. **Header**: "TMH Radiology" + "Desktop" link (→ `index.html?desktop=1`); period title 30px/700 with round chevron button → period dropdown (blurred sheet).
2. **Calendar**: 7-column grid (S M T W T F S), 28 day buttons 48px tall, radius 14; selected = accent fill #9184d9 with dark text; month abbreviation on the 1st and first cell; past days 45% opacity; two 5px dots under the number: accent = today, amber = coverage gap that day.
3. **Day tab**: "On shift" + selected date (24px/700) + "Today" pill; horizontal **swipe deck** (scroll-snap mandatory, 100%-width cards, 12px gap) of Day / Evening / Night cards — header with glowing color dot, name 17px/600, amber "⚠ below min N" when short, count pill; people rows 52px min-height with hairline dividers, name left, time right; **on-call rows fully red**; "No one scheduled" when empty. Three dots below (active stretches to 22px) reflect the visible card and are tappable.
4. **Staff tab**: sections as uppercase grey headers; one card per person (60px collapsed: name, hours balance bar, "Nh · N on call", › chevron); tap to expand every shift in the period (date, pill with times in shift tint / red for on call / dashed for vacation, hours), footer "Weeks a / b / c / d" and total.
5. **Tab bar**: fixed bottom, blurred, segmented Day / Staff (40px, radius 9). Comment bubble (accent-filled, 52px) above it at bottom-right opens a **bottom sheet** comment form (same Formspree posting, `source: "mobile"` added).
6. Analytics script as above.

## Interactions & state (both views)
- `period` (index into PERIODS; defaults to the period containing today, else last), `selected` (day offset 1–28; null = today), focused `people[]`, `hoursOpen`, `coverageOpen`, `dimPast`, `menuOpen`, `chatOpen`, comment `draft`/`author`/`sending`/`sendStatus`; mobile adds `view` (day|staff), `open` (expanded person), `card` (visible swipe card).
- Transitions 150–200ms ease on chevrons, switch knob, tab backgrounds, row opacity/blur.

## Design tokens (desktop)
Ground #161826 · surface #232532 · raised #2b2741 · section row bg #1c1e2b · borders #3f424d / #292b31 / rgba(233,233,237,0.06) · text #e9e9ed · muted #b2b6ca / #9397ab / #75798c / #595d6c · accent #9184d9, light #b5abfc / #d2cefd / #e7e5fe, deep #5d5294 / #423a6a. Shift hues (OKLCH): Day 75, Evening 289, Night 205 — dot L0.73 C0.125, fill L0.36 C0.07, text L0.92. On call fill oklch(0.48 0.16 25). Warning oklch(0.8 0.15 70); OK oklch(0.75 0.15 150). Radii 4/6/8/10; type 9.5–24px Inter, weights 400/500/600.

## Assets
`avatar.png` (512) / `avatar-128.png` — project mark (mini schedule grid). No photography. Icons are inline SVG (phone, chat bubble); the design system prefers Phosphor icons for anything new.

## Screenshots (`screenshots/`)
- `01-desktop.png` — desktop grid, default state (today selected, hours & vacancies collapsed)
- `02-desktop.png` — comment dialog open over blurred page
- `01-mobile.png` — Day tab: calendar + swipe cards
- `02-mobile.png` — Staff tab, collapsed
- `03-mobile.png` — Staff tab with one person expanded
- `04-mobile.png` — comment bottom sheet
Note: the mobile captures were taken at preview-pane width, not a phone viewport; layout is max-width 560 centered.

## Files
- `deploy/` — exactly what's live: index.html, mobile.html, schedule-data.js, support.js, _ds/, README.md
- `design/` — editable design sources (`*.dc.html`), schedule-data.js, Nocturne design system (`_ds/`), avatars
- `design/scans/` — the two original paper schedules (rotated PNGs) the data was transcribed from
