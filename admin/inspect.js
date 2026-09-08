// Shared checks for the schedule console. Runs in the browser (window.ScheduleInspect)
// and in Node (module.exports). Keep this file free of DOM and Node-only APIs.
//
// Roles:
//   data     schedule-data.js  — `export const PERIODS = [...]`, the schedule itself
//   desktop  index.html        — desktop page, loads ./schedule-data.js
//   mobile   mobile.html       — phone page, loads ./schedule-data.js
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ScheduleInspect = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MAX_BYTES = 2 * 1024 * 1024;
  const CODES = { '7': '7a-730p', '(7)': '7a-730p', '8': '8a-430p', '(8)': '8a-430p', '3': '3p-1130p', '11': '11p-730a' };

  // Snippets that the deploy copy of each page carries and a raw design export does not.
  const ANALYTICS = '<script>window.va = window.va || function () { (window.vaq = window.vaq || []).push(arguments); };</script>\n<script defer src="/_vercel/insights/script.js"></script>\n';
  const PHONE_REDIRECT = '<script>(function(){try{var q=location.search;if(/[?&]desktop/.test(q)){sessionStorage.setItem(\'tmh-desktop\',\'1\');return;}if(sessionStorage.getItem(\'tmh-desktop\'))return;var phone=window.matchMedia(\'(max-width: 820px) and (pointer: coarse)\').matches||/iPhone|Android.+Mobile/i.test(navigator.userAgent);if(phone)location.replace(\'mobile.html\');}catch(e){}})();</script>\n';

  const byteLength = s => (typeof TextEncoder !== 'undefined') ? new TextEncoder().encode(s).length : Buffer.byteLength(s, 'utf8');

  // ---------- shift parsing (ported from the page) ----------
  const toMin = (h, m, mer) => ((h % 12) + (mer === 'p' ? 12 : 0)) * 60 + m;
  function parseShift(raw) {
    const red = raw.includes('*'), pen = raw.includes('~');
    const code = raw.replace(/[*~]/g, '').trim();
    if (code === '/') return { kind: 'off', red, pen };
    if (code === 'V') return { kind: 'vac', red, pen };
    if (code === 'H') return { kind: 'hol', red, pen };
    const rangeStr = (CODES[code] || code).replace(/^SF\s+/, '').split(/\s+/)[0];
    const m = rangeStr.match(/^(\d{1,2})(\d{2})?([ap])?-(\d{1,2})(\d{2})?([ap])?$/);
    if (!m) return { kind: 'unknown', red, pen, code };
    const sh = +m[1], eh = +m[4];
    let endMer = m[6], startMer = m[3];
    if (!endMer) endMer = (!startMer && (eh < sh || eh === 12)) ? 'p' : (startMer || 'a');
    if (!startMer) startMer = m[6] ? endMer : 'a';
    const start = toMin(sh, +(m[2] || 0), startMer), end = toMin(eh, +(m[5] || 0), endMer);
    let dur = end - start; if (dur <= 0) dur += 1440;
    const type = start < 600 ? 'day' : start < 1080 ? 'eve' : 'night';
    return { kind: 'shift', red, pen, code, hours: dur / 60, type };
  }

  // ---------- classify ----------
  function classify(text, name) {
    const n = String(name || '').toLowerCase();
    if (/export\s+const\s+PERIODS\s*=/.test(text)) return 'data';
    if (/<x-dc[\s>]/.test(text)) {
      if (/source:\s*['"]mobile['"]/.test(text) || />\s*Desktop\s*<\/a>/.test(text) || /mobile\.dc\.html|mobile\.html/i.test(n)) return 'mobile';
      return 'desktop';
    }
    if (/const\s+PERIODS\s*=\s*\[/.test(text)) return 'legacy';
    if (n.endsWith('.js')) return 'data';
    return 'unknown';
  }

  // ---------- evaluate schedule-data.js ----------
  function evaluateData(src, evaluator) {
    const code = src.replace(/^\s*export\s+(const|let|var)\s+PERIODS\b/m, '$1 PERIODS') + '\n;PERIODS;';
    if (/\bimport\b|\brequire\s*\(|\bfetch\s*\(|\bXMLHttpRequest\b|\bprocess\b|\bglobalThis\b/.test(src)) {
      throw new Error('The data file must contain only the PERIODS array. It has code that does not belong there.');
    }
    return evaluator(code);
  }

  function inspectData(src, evaluator) {
    const errors = [], warnings = [], periods = [];
    const bytes = byteLength(src);
    if (!src || !src.trim()) return { role: 'data', ok: false, errors: ['The file is empty.'], warnings, periods, bytes };
    if (bytes > MAX_BYTES) errors.push('The file is over 2 MB.');
    if (!/export\s+const\s+PERIODS\s*=/.test(src)) errors.push('No `export const PERIODS` in the file. The pages import PERIODS from schedule-data.js.');
    let P;
    try { P = evaluateData(src, evaluator); } catch (e) { errors.push('The file is not valid JavaScript: ' + (e && e.message ? e.message : e)); }
    if (P !== undefined) {
      if (!Array.isArray(P) || !P.length) errors.push('PERIODS must be a non-empty array.');
      else P.forEach((p, i) => {
        const where = `Period ${i + 1}`;
        if (!p || typeof p !== 'object') { errors.push(`${where} is not an object.`); return; }
        const label = String(p.label || ''), title = String(p.title || '');
        if (!p.label) errors.push(`${where} has no label.`);
        if (!p.title) errors.push(`${where} has no title.`);
        const st = Array.isArray(p.start) && p.start.length === 3 && p.start.every(Number.isInteger) ? p.start : null;
        let startIso = null;
        if (!st) errors.push(`${where} (${title || label}) has no start [year, monthIndex, day].`);
        else {
          const dt = new Date(Date.UTC(st[0], st[1], st[2]));
          if (st[1] < 0 || st[1] > 11 || st[2] < 1 || st[2] > 31 || dt.getUTCMonth() !== st[1]) errors.push(`${where} (${title}) start date is not a real date: [${st.join(', ')}]. Month index is 0-based (January = 0).`);
          else { startIso = dt.toISOString().slice(0, 10); if (dt.getUTCDay() !== 0) warnings.push(`${where} (${title}) starts on a ${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][dt.getUTCDay()]}. Periods normally start on a Sunday.`); }
        }
        let people = 0, cells = 0, onCall = 0, unknown = [];
        const sections = Array.isArray(p.sections) ? p.sections : (errors.push(`${where} (${title}) has no sections.`), []);
        sections.forEach((sec, si) => {
          if (!Array.isArray(sec) || typeof sec[0] !== 'string' || !Array.isArray(sec[1])) { errors.push(`${where} section ${si + 1} must be [name, [people]].`); return; }
          sec[1].forEach((row, ri) => {
            if (!Array.isArray(row) || typeof row[0] !== 'string' || typeof row[1] !== 'string') { errors.push(`${where} › ${sec[0]} row ${ri + 1} must be [name, cells, note?].`); return; }
            people++;
            const seen = new Set();
            row[1].split(',').forEach(tok => {
              if (!tok.trim()) return;
              const k = tok.indexOf(':');
              const off = k === -1 ? NaN : Number(tok.slice(0, k));
              if (!Number.isInteger(off) || off < 1 || off > 28) { errors.push(`${where} › ${row[0]}: cell "${tok}" needs a day offset from 1 to 28.`); return; }
              if (seen.has(off)) warnings.push(`${where} › ${row[0]}: day ${off} is listed twice.`);
              seen.add(off);
              const s = parseShift(tok.slice(k + 1));
              cells++;
              if (s.red) onCall++;
              if (s.kind === 'unknown') unknown.push(`${row[0]} day ${off} "${s.code}"`);
            });
          });
        });
        if (unknown.length) warnings.push(`${where} (${title}): ${unknown.length} cell${unknown.length > 1 ? 's' : ''} with a code the page cannot read (shown as requested off): ${unknown.slice(0, 6).join(', ')}${unknown.length > 6 ? ', …' : ''}.`);
        if (!people) warnings.push(`${where} (${title}) has no staff rows.`);
        periods.push({ label, title, start: st, startIso, sections: sections.length, people, cells, onCall });
      });
      for (let i = 1; i < periods.length; i++) {
        const a = periods[i - 1], b = periods[i];
        if (a.startIso && b.startIso) {
          const gap = Math.round((Date.parse(b.startIso) - Date.parse(a.startIso)) / 86400000);
          if (gap <= 0) warnings.push(`"${b.title}" does not start after "${a.title}". Periods should be in date order.`);
          else if (gap !== 28) warnings.push(`"${b.title}" starts ${gap} days after "${a.title}" (28 expected).`);
        }
      }
    }
    return { role: 'data', ok: errors.length === 0, errors, warnings, periods, bytes };
  }

  // ---------- pages ----------
  function inspectPage(html, role) {
    const errors = [], warnings = [];
    const bytes = byteLength(html);
    if (!html || !html.trim()) return { role, ok: false, errors: ['The file is empty.'], warnings, bytes, changes: [] };
    if (bytes > MAX_BYTES) errors.push('The file is over 2 MB.');
    if (!/<x-dc[\s>]/.test(html) || !html.includes('</x-dc>')) errors.push('No <x-dc> block. This is not an exported schedule page.');
    if (!/data-dc-script/.test(html)) errors.push('No data-dc-script block. The page has no logic script.');
    if (/const\s+PERIODS\s*=\s*\[/.test(html)) errors.push('This page carries the schedule inline. The site now loads schedule-data.js. Export the current design instead.');
    else if (!/import\(\s*['"]\.\/schedule-data\.js['"]\s*\)/.test(html)) errors.push('The page does not import ./schedule-data.js.');
    if (!/support\.js/.test(html)) warnings.push('The page does not load support.js. It will not render.');
    const prepared = prepare(html, role);
    return { role, ok: errors.length === 0, errors, warnings, bytes, changes: prepared.changes, html: prepared.html };
  }

  // Turns a raw Claude Design export into the deploy copy: fixes cross-links and adds the analytics
  // and phone-redirect scripts. Idempotent: a deploy copy passes through unchanged.
  function prepare(html, role) {
    const changes = [];
    let out = html;
    if (/href="X-ray Schedule Mobile\.dc\.html"/.test(out)) { out = out.replace(/href="X-ray Schedule Mobile\.dc\.html"/g, 'href="mobile.html"'); changes.push('Pointed the mobile link at mobile.html.'); }
    if (/href="X-ray Schedule\.dc\.html"/.test(out)) { out = out.replace(/href="X-ray Schedule\.dc\.html"/g, 'href="index.html?desktop=1"'); changes.push('Pointed the desktop link at index.html?desktop=1.'); }
    const support = /<script src="\.\/support\.js"><\/script>/;
    if (support.test(out)) {
      if (!/_vercel\/insights\/script\.js/.test(out)) { out = out.replace(support, m => ANALYTICS + m); changes.push('Added the Vercel Analytics script.'); }
      if (role === 'desktop' && !/tmh-desktop/.test(out)) { out = out.replace(support, m => PHONE_REDIRECT + m); changes.push('Added the phone redirect to mobile.html.'); }
    }
    return { html: out, changes };
  }

  function inspect(role, text, evaluator) {
    if (role === 'data') return inspectData(text, evaluator);
    if (role === 'desktop' || role === 'mobile') return inspectPage(text, role);
    if (role === 'legacy') return { role, ok: false, errors: ['This page carries the schedule inline. The site now loads schedule-data.js. Export the current design instead.'], warnings: [], bytes: byteLength(text) };
    return { role, ok: false, errors: ['Not a schedule file. Drop schedule-data.js, the desktop page, or the mobile page.'], warnings: [], bytes: byteLength(text) };
  }

  return { classify, inspect, inspectData, inspectPage, prepare, parseShift, MAX_BYTES };
});
