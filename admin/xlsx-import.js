// Convert an uploaded .xlsx staff schedule into the schedule-data.js PERIODS shape.
// Runs in the browser (window.ScheduleXlsx) and in Node (module.exports). No DOM,
// no Node-only APIs. The actual .xlsx parsing (SheetJS) happens in the caller; this
// module works on a plain array-of-arrays (aoa) grid so it stays testable.
//
// Expected sheet layout (one sheet = one 28-day period):
//   - a title row somewhere near the top whose text carries the 4-digit year
//     (optional when each date header names its weekday, e.g. "Sun 11/22")
//   - a date row: first cell "Date" or "Name", then the 28 dates across
//     ("11/22", "11/22/2026", or "Sun 11/22")
//   - section header rows in column A: DAYSHIFT / EVENING SHIFT / MIDNIGHT / PRN
//   - staff rows: column A = name, the 28 day columns = shift codes
//   - WEEK, VACANCIES, and Legend rows are ignored
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
  const SKIP_ROW = /^(vacanc|legend|day$|date$|name$|week\b)/i;
  const WD = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
  const WDNAME = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  const s = v => (v === null || v === undefined) ? '' : String(v).trim();
  const BREAK = /[\r\n\u2028\u2029]/;

  // Does a 6-hex fill colour read as red? Excel red (FF0000), dark red (C00000), the theme red
  // (C0504D) and FF6666 pass. Pink (FFC7CE), orange (ED7D31), yellow and brown do not.
  function isRedFill(rgb) {
    const h = String(rgb || '').replace(/^#/, '').slice(-6);
    if (!/^[0-9a-f]{6}$/i.test(h)) return false;
    const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
    return r >= 0xB0 && g <= 0x70 && b <= 0x70 && r - Math.max(g, b) >= 0x50;
  }

  // "2-11:30p" -> "2-1130p": the page reads 1130p, not 11:30p. A range with no a/p at all
  // that starts at 1-6 is an afternoon shift ("2-11:30" -> "2p-1130p"). Ranges that start
  // at 7 or later keep the page's own rule ("8-12" -> 8a-12p). Anything else passes through.
  function fixRange(word) {
    if (!/^\d{1,2}(:\d{2})?[ap]?-\d{1,2}(:\d{2})?[ap]?$/i.test(word)) return word;
    const w = word.replace(/(\d{1,2}):(\d{2})/g, '$1$2');
    const m = w.match(/^(\d{1,2})(\d{2})?-(\d{1,2})(\d{2})?$/);
    if (m && +m[1] >= 1 && +m[1] <= 6) return `${m[1]}${m[2] || ''}p-${m[3]}${m[4] || ''}p`;
    return w;
  }

  // A cell value -> the code stored in schedule-data.js. Blank -> null (day omitted).
  function normalizeCell(raw) {
    let c = s(raw).replace(/\s+/g, ' '); // a line break or NBSP inside a cell would break the generated file
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
    return core.replace(/^\S+/, fixRange(first)) + flags; // ranges are fixed; shorthand, V/H//, notes pass through
  }

  function yearInText(text) {
    const m = String(text || '').match(/\b(20\d{2})\b/);
    return m ? +m[1] : null;
  }

  // Parse a date cell into {y, m1, d, weekday, hadYear}. Accepts a Date, "M/D",
  // "M/D/YY", "M-D", or a weekday prefix ("Sun 11/22"). y stays null when the
  // cell itself has no year and no fallback was passed.
  function parseDateCell(v, fallbackYear) {
    if (v instanceof Date && !isNaN(v.getTime())) {
      return { y: v.getFullYear(), m1: v.getMonth() + 1, d: v.getDate(), weekday: null, hadYear: true };
    }
    const t = s(v);
    const m = t.match(/^(?:(sun|mon|tue|wed|thu|fri|sat)[a-z.]*\s+)?(\d{1,2})\s*([\/\-])\s*(\d{1,2})(?:\s*[\/\-]\s*(\d{2,4}))?$/i);
    if (!m) return null;
    const m1 = +m[2], d = +m[4];
    if (m1 < 1 || m1 > 12 || d < 1 || d > 31) return null;
    const weekday = m[1] ? WD[m[1].toLowerCase()] : null;
    const hadYear = !!m[5];
    let y = hadYear ? +m[5] : (fallbackYear == null ? null : fallbackYear);
    if (hadYear && m[5].length === 2) y = 2000 + +m[5];
    return { y, m1, d, weekday, hadYear, slash: m[3] === '/' };
  }

  // A date header, not a shift like "8-12". Requires a slash, a weekday, a year, or a Date.
  function headerDate(v) {
    const p = parseDateCell(v, null);
    if (!p) return null;
    if (v instanceof Date) return p;
    if (!p.slash && p.weekday == null && !p.hadYear) return null;
    return p;
  }

  function countHeaderDates(row) {
    let n = 0;
    for (let c = 1; c < (row || []).length; c++) if (headerDate(row[c])) n++;
    return n;
  }

  // Year in which month/day falls on weekday (0 = Sunday), closest to aroundYear.
  // On a tie, the later year wins — a schedule is current or upcoming.
  function yearForWeekday(month, day, weekday, aroundYear) {
    const target = aroundYear || new Date().getFullYear();
    let best = null, bestDist = Infinity;
    for (let y = target - 12; y <= target + 12; y++) {
      const dt = new Date(y, month - 1, day);
      if (dt.getFullYear() !== y || dt.getMonth() !== month - 1 || dt.getDate() !== day) continue;
      if (dt.getDay() !== weekday) continue;
      const dist = Math.abs(y - target);
      if (dist < bestDist || (dist === bestDist && y > best)) { best = y; bestDist = dist; }
    }
    return best;
  }

  const fmtRange = (a, b) => `${MONTHS[a.getMonth()]} ${a.getDate()} – ${MONTHS[b.getMonth()]} ${b.getDate()}, ${b.getFullYear()}`;
  const fmtLabel = (a, b) => `${MON3[a.getMonth()]} ${a.getDate()} – ${MON3[b.getMonth()]} ${b.getDate()}`;

  // `fills` (optional) is a grid parallel to `aoa` holding each cell's solid-fill rgb ('' = none).
  // `opts.name` (optional) is the file name, used when that is the only place a year is written.
  function aoaToPeriod(aoa, fills, opts) {
    const warnings = [], errors = [];
    const palette = {}; let onCallMarked = 0, redBlank = 0;
    const rows = (aoa || []).map(r => (r || []).map(s));
    if (!rows.length) { errors.push('The sheet is empty.'); return { errors, warnings }; }

    // year: first 4-digit year in the top rows (title), else in the file name
    let year = null;
    for (let i = 0; i < Math.min(rows.length, 4); i++) {
      year = yearInText(rows[i].join(' '));
      if (year) break;
    }
    if (!year && opts && opts.name) year = yearInText(opts.name);

    // date row: a "Date" label, or (the Name-row layout) the row with the dates across
    const labeled = rows.findIndex(r => /^date$/i.test(r[0] || ''));
    let dateRowIdx = labeled;
    if (dateRowIdx === -1) {
      let best = -1, bestN = 0;
      for (let i = 0; i < (aoa || []).length; i++) {
        const n = countHeaderDates(aoa[i]);
        if (n > bestN) { bestN = n; best = i; }
      }
      if (bestN >= 7) dateRowIdx = best;
    }
    if (dateRowIdx === -1) { errors.push('No date row found. Expected a row starting with "Date" or "Name", with the 28 dates across (11/22 or Sun 11/22).'); return { errors, warnings }; }
    const dateRow = aoa[dateRowIdx] || [];
    // day columns = columns after A that hold a date, in order. On a labeled Date
    // row, keep any filled cell so an unusual date text still errors clearly.
    const dayCols = [];
    for (let c = 1; c < dateRow.length; c++) {
      const cell = dateRow[c];
      if (!s(cell) && !(cell instanceof Date)) continue;
      if (labeled === -1 && !headerDate(cell)) continue;
      dayCols.push(c);
    }
    if (!dayCols.length) { errors.push('The date row has no dates.'); return { errors, warnings }; }
    if (dayCols.length < 28) warnings.push(`The date row has ${dayCols.length} date columns; expected 28.`);
    if (dayCols.length > 28) { warnings.push(`The date row has ${dayCols.length} date columns; using the first 28.`); dayCols.length = 28; }

    const first = parseDateCell(dateRow[dayCols[0]], null);
    if (!first) { errors.push(`Could not read the first date cell ("${s(dateRow[dayCols[0]])}").`); return { errors, warnings }; }
    if (!first.hadYear) {
      if (year) first.y = year;
      else if (first.weekday != null) {
        const inferred = yearForWeekday(first.m1, first.d, first.weekday, new Date().getFullYear());
        if (!inferred) { errors.push(`Could not tell which year "${s(dateRow[dayCols[0]])}" falls in.`); return { errors, warnings }; }
        first.y = inferred;
        warnings.push(`No 4-digit year in the sheet. "${s(dateRow[dayCols[0]])}" is a ${WDNAME[first.weekday]} in ${inferred}, so the period starts then.`);
      } else {
        first.y = new Date().getFullYear();
        warnings.push(`No 4-digit year found in the sheet; used ${first.y}.`);
      }
    } else if (!year) warnings.push('No 4-digit year found in the title row; used the first date cell’s year.');
    const start = new Date(first.y, first.m1 - 1, first.d);
    if (isNaN(start) || start.getFullYear() !== first.y || start.getMonth() !== first.m1 - 1 || start.getDate() !== first.d) { errors.push('The start date is not valid.'); return { errors, warnings }; }
    if (first.weekday != null && start.getDay() !== first.weekday) warnings.push(`"${s(dateRow[dayCols[0]])}" says ${WDNAME[first.weekday]}, but ${MONTHS[start.getMonth()]} ${start.getDate()}, ${start.getFullYear()} is a ${WDNAME[start.getDay()]}.`);
    for (let idx = 1; idx < dayCols.length; idx++) {
      const p = parseDateCell(dateRow[dayCols[idx]], null);
      if (!p) continue;
      const expect = new Date(start.getFullYear(), start.getMonth(), start.getDate() + idx);
      const y = p.hadYear ? p.y : expect.getFullYear();
      const got = new Date(y, p.m1 - 1, p.d);
      if (got.getFullYear() !== expect.getFullYear() || got.getMonth() !== expect.getMonth() || got.getDate() !== expect.getDate()) {
        warnings.push(`"${s(dateRow[dayCols[idx]])}" is not ${MON3[expect.getMonth()]} ${expect.getDate()}. Columns are still read left to right from the first date.`);
        break;
      }
    }
    const end = new Date(start); end.setDate(end.getDate() + 27);

    // walk staff rows under section headers
    const sections = []; let cur = null;
    for (let i = dateRowIdx + 1; i < rows.length; i++) {
      const name = rows[i][0].replace(/\s+/g, ' ');
      if (!name) continue;
      if (BREAK.test(rows[i][0])) warnings.push(`Row ${i + 1} "${name}": the name has a line break; treated as a space.`);
      const sec = SECTIONS.find(([re]) => re.test(name));
      if (sec && rows[i].slice(1).every(x => !x)) { cur = [sec[1], []]; sections.push(cur); continue; }
      if (SKIP_ROW.test(name)) continue;
      // staff row
      const parts = [];
      dayCols.forEach((c, idx) => {
        const raw = aoa[i] ? aoa[i][c] : '';
        // A notation on a second line is the same as one on the same line ("7a-730p SP"): no warning.
        // Two times in one cell is different: the page keeps the first and shows the rest as a note.
        if (BREAK.test(s(raw))) {
          const flat = s(raw).replace(/\s+/g, ' ');
          if (flat.split(' ').filter(w => /\d/.test(w) && w.includes('-')).length > 1) warnings.push(`"${name}" day ${idx + 1}: the cell has two times ("${flat}"); the page shows the first and keeps the rest as a note.`);
        }
        let code = normalizeCell(raw);
        const fill = fills && fills[i] ? String(fills[i][c] || '').slice(-6).toUpperCase() : '';
        if (fill) palette[fill] = (palette[fill] || 0) + 1;
        if (isRedFill(fill)) {
          // red fill = on call (the "*" suffix). Off, vacation and holiday cells keep no mark.
          if (code === null) redBlank++;
          else if (!code.includes('*') && !['/', 'V', 'H'].includes(code.replace(/[*~]/g, ''))) { code += '*'; onCallMarked++; }
        }
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
    return { period, warnings, errors, fillStats: fills ? { palette, onCallMarked, redBlank } : null };
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

  // Backstop: whatever reaches here, the output stays a valid JS string literal.
  const q = str => "'" + String(str).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029') + "'";

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

  return { aoaToPeriod, normalizeCell, mergePeriod, serialize, isRedFill };
});
