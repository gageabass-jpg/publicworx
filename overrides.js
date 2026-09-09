// Shared, dependency-free logic for the "live changes" (override) layer.
//
// The manager's schedule (schedule-data.js PERIODS) is the baseline and stays the
// source of truth. Live changes — call-ins, swaps, sick days, on-call moves — are
// stored separately as override records and layered on top of the baseline at read
// time. This module does the layering. It is used by the public pages (in the
// browser) and by the Node tests. It never mutates the baseline it is given.
//
// Override record shape (see api/overrides.js for validation):
//   { id, periodKey, section?, person, day, code, reason?, author?, status?, note?, createdAt?, updatedAt? }
//   - periodKey : the period's start date as "YYYY-MM-DD" (stable across title edits)
//   - person    : exact name as it appears in the baseline (e.g. "Donnie (traveler)")
//   - day       : 1..28 offset within the period
//   - code      : the new cell code (e.g. "3", "V", "7a-430p*"), or null/"" to clear
//                 that day (the person is off / removed for that day)
//   - status    : only records with status "live" (or no status) are applied here;
//                 "pending" suggestions are held back for approval.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ScheduleOverrides = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // The period's stable key: its start date as "YYYY-MM-DD".
  function periodKey(period) {
    var s = period && period.start;
    if (!Array.isArray(s) || s.length !== 3) return '';
    var mm = String(s[1] + 1).padStart(2, '0');
    var dd = String(s[2]).padStart(2, '0');
    return s[0] + '-' + mm + '-' + dd;
  }

  // "1:7a-430p,3:V" -> { 1: "7a-430p", 3: "V" }
  function parseCells(str) {
    var map = {};
    String(str || '').split(',').forEach(function (tok) {
      tok = tok.trim();
      if (!tok) return;
      var k = tok.indexOf(':');
      if (k === -1) return;
      var off = Number(tok.slice(0, k));
      if (!Number.isInteger(off)) return;
      map[off] = tok.slice(k + 1);
    });
    return map;
  }

  // { 3: "V", 1: "7a-430p" } -> "1:7a-430p,3:V" (offsets sorted)
  function formatCells(map) {
    return Object.keys(map)
      .map(Number)
      .sort(function (a, b) { return a - b; })
      .map(function (o) { return o + ':' + map[o]; })
      .join(',');
  }

  function clonePeriods(periods) {
    return (periods || []).map(function (p) {
      return Object.assign({}, p, {
        sections: (p.sections || []).map(function (sec) {
          return [sec[0], (sec[1] || []).map(function (row) { return row.slice(); })];
        }),
      });
    });
  }

  function isClear(code) { return code === null || code === undefined || code === ''; }

  // Apply live overrides to a copy of the baseline periods.
  // Returns { periods, changes } where:
  //   periods  : the effective schedule (baseline + overrides), same shape as the input
  //   changes  : { periodKey: { person: { day: {from, to, reason, author, at} } } }
  //              — metadata the UI uses to mark and explain each changed cell.
  function applyOverrides(periods, overrides) {
    var out = clonePeriods(periods);
    var changes = {};
    var byKey = {};
    out.forEach(function (p) { byKey[periodKey(p)] = p; });

    (overrides || []).forEach(function (ov) {
      if (!ov) return;
      if (ov.status && ov.status !== 'live') return; // suggestions wait for approval
      var p = byKey[ov.periodKey];
      if (!p) return; // override for a period not currently loaded
      var day = Number(ov.day);
      if (!Number.isInteger(day) || day < 1 || day > 28) return;

      // Find the person's row, remembering the section it lived in.
      var row = null;
      for (var i = 0; i < p.sections.length; i++) {
        var rows = p.sections[i][1];
        var found = rows.find(function (r) { return r[0] === ov.person; });
        if (found) { row = found; break; }
      }
      // Not in the baseline for this period -> add them (e.g. a picked-up shift).
      if (!row) {
        var sec = null;
        for (var j = 0; j < p.sections.length; j++) {
          if (p.sections[j][0] === ov.section) { sec = p.sections[j]; break; }
        }
        if (!sec) { sec = p.sections[0]; }
        if (!sec) { sec = [ov.section || 'Added', []]; p.sections.push(sec); }
        row = ov.note ? [ov.person, '', ov.note] : [ov.person, ''];
        sec[1].push(row);
      }

      var map = parseCells(row[1]);
      var from = Object.prototype.hasOwnProperty.call(map, day) ? map[day] : null;
      var to;
      if (isClear(ov.code)) { delete map[day]; to = null; }
      else { map[day] = String(ov.code); to = String(ov.code); }
      row[1] = formatCells(map);

      if (!changes[ov.periodKey]) changes[ov.periodKey] = {};
      if (!changes[ov.periodKey][ov.person]) changes[ov.periodKey][ov.person] = {};
      changes[ov.periodKey][ov.person][day] = {
        from: from,
        to: to,
        reason: ov.reason || '',
        author: ov.author || '',
        at: ov.updatedAt || ov.createdAt || null,
      };
    });

    return { periods: out, changes: changes };
  }

  return {
    periodKey: periodKey,
    parseCells: parseCells,
    formatCells: formatCells,
    applyOverrides: applyOverrides,
  };
});
