// Builds a .ics calendar for one person from PERIODS. Shared by the mobile page
// (window.ScheduleIcs, "Download file") and api/calendar.js (the live subscription link),
// so both produce the same events with the same IDs. No DOM, no Node-only APIs.
//
// parseCode is a port of parseCode in mobile.html. If the page's time rules change, change both.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ScheduleIcs = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function parseTok(t) {
    const m = t.match(/^(\d{1,2}):?(\d{2})?(a|p)?$/); if (!m) return null;
    const h = +m[1], mm = m[2] || '', ap = m[3];
    return { label: h + (mm ? ':' + mm : ''), h, mm, ap };
  }

  function parseCode(raw) {
    const oncall = raw.includes('*'); let c = raw.replace(/[*~]/g, '').trim();
    if (c === '/') return { off: true };
    if (c === 'V') return { vac: true };
    if (c === 'H') return { hol: true };
    if (/^or\b/i.test(c)) return { orient: true };
    const maps = { '7': '7a-730p', '(7)': '7a-730p', '8': '8a-430p', '(8)': '8a-430p', '3': '3p-1130p', '11': '11p-730a', '2-1130p': '2p-1130p', '1-1130p': '1p-1130p', '530-1130p': '530p-1130p', '7-230': '7a-230p' };
    if (maps[c]) c = maps[c];
    const words = c.split(' ');
    const ti = words.findIndex(w => /\d/.test(w) && w.includes('-'));
    if (ti < 0) return { off: true };
    const extra = words.filter((w, i) => i !== ti).join(' ');
    const note = extra && !/^\(.*\)$/.test(extra) ? '(' + extra + ')' : extra; // notes show in parentheses
    const [sT, eT] = words[ti].split('-');
    const s = parseTok(sT), e = parseTok(eT);
    if (!s || !e) return { off: true };
    if (!e.ap) e.ap = 'p'; if (!s.ap) s.ap = 'a';
    const h24 = t => t.h % 12 + (t.ap === 'p' ? 12 : 0) + (t.mm ? +t.mm / 60 : 0);
    const sH = h24(s); let eH = h24(e); if (eH <= sH) eH += 24;
    const sL = s.label + s.ap, eL = e.label + e.ap;
    return { sL, eL, sH, eH, extra, oncall, time: sL + '\u2013' + eL + (note ? ' ' + note : '') };
  }

  // Where a normal shift happens. A note of SF (St. Francis / Thomas Orthopedic) or UC (University of
  // Charleston, without TMH) means another site, and we do not know that address, so no LOCATION.
  const HOSPITAL = 'Thomas Memorial Hospital, 4605 MacCorkle Ave SW, South Charleston, WV 25309';
  function placeFor(p) {
    const w = String(p.extra || '').toUpperCase().split(/\s+/);
    if (w.includes('SF') || (w.includes('UC') && !w.includes('TMH'))) return '';
    return HOSPITAL;
  }

  const clean = nm => String(nm).replace(' (traveler)', '');
  const slug = nm => String(nm).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  // Every name in the data, sorted.
  function names(periods) {
    const seen = {};
    periods.forEach(per => per.sections.forEach(([, rows]) => rows.forEach(([name]) => { seen[clean(name)] = true; })));
    return Object.keys(seen).sort((a, b) => a.localeCompare(b));
  }

  // One person's working shifts. opts.from (a Date): drop shifts that ended before that day.
  // opts.removed (a Set of "period title||day||name"): drop shifts with an approved removal.
  // Times are floating wall-clock numbers (built and read with UTC getters), so the result
  // does not depend on the time zone of the machine.
  function shifts(periods, name, opts) {
    opts = opts || {};
    const out = [], seen = {};
    const from = opts.from ? Date.UTC(opts.from.getFullYear(), opts.from.getMonth(), opts.from.getDate()) : null;
    periods.forEach(per => {
      per.sections.forEach(([, rows]) => rows.forEach(([rowName, spec]) => {
        if (clean(rowName) !== name) return;
        spec.split(',').forEach(ent => {
          const i = ent.indexOf(':'); const o = +ent.slice(0, i);
          const p = parseCode(ent.slice(i + 1));
          if (p.off || p.vac || p.hol || p.orient) return;
          if (opts.removed && opts.removed.has(per.title + '||' + o + '||' + name)) return;
          const at = h => new Date(Date.UTC(per.start[0], per.start[1], per.start[2] + o - 1, 0, Math.round(h * 60)));
          const start = at(p.sH), end = at(p.eH);
          if (from !== null && end.getTime() <= from) return;
          const uid = 'tmh-' + slug(name) + '-' + per.start.join('-') + '-' + o + '@schedule.exchange';
          if (seen[uid]) return; seen[uid] = true;
          out.push({ uid, start, end, oncall: p.oncall, time: p.time, place: placeFor(p) });
        });
      }));
    });
    return out.sort((a, b) => a.start - b.start);
  }

  // The .ics text. opts: from, removed (see shifts), subscribe (adds refresh hints), now (a Date).
  function text(periods, name, opts) {
    opts = opts || {};
    const pad = n => String(n).padStart(2, '0');
    const local = d => d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) + 'T' + pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + '00';
    const esc = x => String(x).replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
    const fold = l => { let o = '', r = l; while (r.length > 60) { o += r.slice(0, 60) + '\r\n '; r = r.slice(60); } return o + r; };
    const n = opts.now || new Date();
    const stamp = n.getUTCFullYear() + pad(n.getUTCMonth() + 1) + pad(n.getUTCDate()) + 'T' + pad(n.getUTCHours()) + pad(n.getUTCMinutes()) + pad(n.getUTCSeconds()) + 'Z';
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//TMH Radiology Schedule//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:' + esc('TMH Radiology \u2013 ' + name)];
    if (opts.subscribe) lines.push('REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H');
    shifts(periods, name, opts).forEach(s => {
      lines.push('BEGIN:VEVENT', 'UID:' + s.uid, 'DTSTAMP:' + stamp, 'DTSTART:' + local(s.start), 'DTEND:' + local(s.end),
        'SUMMARY:' + esc('TMH Radiology' + (s.oncall ? ' \u2013 On call' : '')),
        'DESCRIPTION:' + esc(s.time + (s.oncall ? ' \u00b7 On call' : '')));
      if (s.place) lines.push('LOCATION:' + esc(s.place));
      lines.push('END:VEVENT');
    });
    lines.push('END:VCALENDAR');
    return lines.map(fold).join('\r\n') + '\r\n';
  }

  return { parseCode, names, shifts, text, slug };
});
