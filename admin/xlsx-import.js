// Convert an uploaded .xlsx staff schedule into the schedule-data.js PERIODS shape.
// Runs in the browser (window.ScheduleXlsx) and in Node (module.exports). No DOM,
// no Node-only APIs. The actual .xlsx parsing (SheetJS) happens in the caller; this
// module works on a plain array-of-arrays (aoa) grid so it stays testable.
//
// Expected sheet layout (one sheet = one 28-day period):
//   - a title row somewhere near the top whose text carries the 4-digit year
//   - a row whose first cell is "Date" with 28 date cells (M/D or real dates) across
//   - section header rows in column A: DAYSHIFT / EVENING SHIFT / MIDNIGHT / PRN
//   - staff rows: column A = name, the 28 day columns = shift codes
//   - VACANCIES and Legend rows are ignored
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ScheduleXlsx = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const MON3 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  // bare shorthand -> explicit range, used only when a note is attached (e.g. "11 CT")
  const EXPAND = { '7': '7a-730p', '(7)': '7a-730p', '8': '8a-430p', '(8)': '8a-430p', '3': '3p-1130p', '11': '11p-730a' };
  const SECTIONS = [
    [/^day/i, 'Day shift'],
    [/^even/i, 'Evening shift'],
    [/^(mid|night)/i, 'Midnight shift'],
    [/^prn/i, 'PRN'],
  ];
  const SKIP_ROW = /^(vacanc|legend|day$|date$)/i;

  const s = v => (v === null || v === undefined) ? '' : String(v).trim();

  // A cell value -> the code stored in schedule-data.js. Blank -> null (day omitted).
  function normalizeCell(raw) {
    let c = s(raw);
    if (!c) return null;
    // keep on-call (*) / pen (~) markers wherever they sit
    const flags = (c.match(/[*~]/g) || []).join('');
    let core = c.replace(/[*~]/g, '').trim();
    if (!core) return null;
    if (core === '/' || core === 'V' || core === 'H') return core + flags;
    if (/^or\b/i.test(core)) return 'Or' + (core.length > 2 ? ' ' + core.slice(2).trim() : '') + flags;
    const words = core.split(/\s+/);
    const first = words[0];
    // shorthand + trailing note ("11 CT") -> expand so the page can read it
    if (words.length > 1 && Object.prototype.hasOwnProperty.call(EXPAND, first)) {
      return EXPAND[first] + ' ' + words.slice(1).join(' ') + flags;
    }
    return core + flags; // ranges, bare shorthand, V/H//, notes-as-written pass through
  }

  // Parse a date cell into {y, m1, d}: real Date, JS Date, or "M/D"/"M/D/YY".
  function parseDateCell(v, fallbackYear) {
    if (v instanceof Date && !isNaN(v)) return { y: v.getFullYear(), m1: v.getMonth() + 1, d: v.getDate() };
    const t = s(v);
    let m = t.match(/^(\d{1,2})\s*[\/\-]\s*(\d{1,2})(?:\s*[\/\-]\s*(\d{2,4}))?$/);
    if (m) {
      let y = m[3] ? +m[3] : fallbackYear;
      if (m[3] && m[3].length === 2) y = 2000 + +m[3];
      return { y, m1: +m[1], d: +m[2] };
    }
    return null;
  }

  const fmtRange = (a, b) => `${MONTHS[a.getMonth()]} ${a.getDate()} – ${MONTHS[b.getMonth()]} ${b.getDate()}, ${b.getFullYear()}`;
  const fmtLabel = (a, b) => `${MON3[a.getMonth()]} ${a.getDate()} – ${MON3[b.getMonth()]} ${b.getDate()}`;

  function aoaToPeriod(aoa) {
    const warnings = [], errors = [];
    const rows = (aoa || []).map(r => (r || []).map(s));
    if (!rows.length) { errors.push('The sheet is empty.'); return { errors, warnings }; }

    // year: first 4-digit year found in the top rows (title row)
    let year = null;
    for (let i = 0; i < Math.min(rows.length, 4); i++) {
      const m = rows[i].join(' ').match(/\b(20\d{2})\b/);
      if (m) { year = +m[1]; break; }
    }

    // date row: first cell "Date"
    const dateRowIdx = rows.findIndex(r => /^date$/i.test(r[0] || ''));
    if (dateRowIdx === -1) { errors.push('No "Date" row found (a row whose first cell is "Date", with the 28 dates across).'); return { errors, warnings }; }
    const dateRow = aoa[dateRowIdx];
    // day columns = columns after A that hold a date, in order
    const dayCols = [];
    for (let c = 1; c < dateRow.length; c++) if (s(dateRow[c])) dayCols.push(c);
    if (dayCols.length < 28) warnings.push(`The Date row has ${dayCols.length} date columns; expected 28.`);
    if (dayCols.length > 28) { warnings.push(`The Date row has ${dayCols.length} date columns; using the first 28.`); dayCols.length = 28; }

    const first = parseDateCell(dateRow[dayCols[0]], year);
    if (!first) { errors.push(`Could not read the first date cell ("${s(dateRow[dayCols[0]])}").`); return { errors, warnings }; }
    if (!year) { year = first.y; warnings.push('No 4-digit year found in the title row; used the first date cell’s year.'); }
    const start = new Date(first.y || year, first.m1 - 1, first.d);
    if (isNaN(start)) { errors.push('The start date is not valid.'); return { errors, warnings }; }
    const end = new Date(start); end.setDate(end.getDate() + 27);

    // walk staff rows under section headers
    const sections = []; let cur = null;
    for (let i = dateRowIdx + 1; i < rows.length; i++) {
      const name = rows[i][0];
      if (!name) continue;
      const sec = SECTIONS.find(([re]) => re.test(name));
      if (sec && rows[i].slice(1).every(x => !x)) { cur = [sec[1], []]; sections.push(cur); continue; }
      if (SKIP_ROW.test(name)) continue;
      // staff row
      const parts = [];
      dayCols.forEach((c, idx) => {
        const code = normalizeCell(aoa[i] ? aoa[i][c] : '');
        if (code !== null) parts.push((idx + 1) + ':' + code);
      });
      if (!parts.length) { warnings.push(`"${name}" has no shifts in this period; skipped.`); continue; }
      if (!cur) { warnings.push(`"${name}" appears before any section header; skipped.`); continue; }
      cur[1].push([name, parts.join(',')]);
    }
    if (!sections.length) errors.push('No section headers (DAYSHIFT / EVENING SHIFT / MIDNIGHT / PRN) found.');

    const period = {
      label: fmtLabel(start, end),
      title: fmtRange(start, end),
      start: [start.getFullYear(), start.getMonth(), start.getDate()],
      sections,
    };
    return { period, warnings, errors };
  }

  // Replace the period sharing this one's start date; otherwise insert. Keep the rest,
  // sorted by start date ascending.
  function mergePeriod(periods, period) {
    const list = Array.isArray(periods) ? periods.slice() : [];
    const key = p => (p.start || []).join('-');
    const k = key(period);
    const i = list.findIndex(p => key(p) === k);
    if (i === -1) list.push(period); else list[i] = period;
    list.sort((a, b) => (Date.UTC(...(a.start || [0, 0, 0])) - Date.UTC(...(b.start || [0, 0, 0]))));
    return list;
  }

  const HEADER = [
    '// Single source of truth for the schedule. Both the desktop and mobile views read this file.',
    '// Cell syntax: "offset:code" where offset 1 = first day of the period. Suffix * = on call, ~ = pen edit.',
    '// Codes: 7 = 7a-730p, (7)/(8) = same shift in parentheses on the paper, 8 = 8a-430p, 3 = 3p-1130p, 11 = 11p-730a, / = requested off, V = vacation, H = holiday, Or = orientation.',
  ].join('\n');

  const q = str => "'" + String(str).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";

  function serialize(periods) {
    const body = periods.map(p => {
      const secs = (p.sections || []).map(([name, people]) => {
        const rows = people.map(r => '      [' + r.map(q).join(', ') + '],').join('\n');
        return `    [${q(name)}, [\n${rows}\n    ]],`;
      }).join('\n');
      return `  { label: ${q(p.label)}, title: ${q(p.title)}, start: [${p.start.join(', ')}], sections: [\n${secs}\n  ]},`;
    }).join('\n');
    return `${HEADER}\nexport const PERIODS = [\n${body}\n];\n`;
  }

  return { aoaToPeriod, normalizeCell, mergePeriod, serialize };
});
