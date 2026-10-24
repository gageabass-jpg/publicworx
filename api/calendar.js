// Vercel serverless function: a live calendar for one person, as a subscribable .ics feed.
//
//   GET /api/calendar?name=Angela%20(T)
//
// On an iPhone the mobile page opens this as webcal://, so Calendar subscribes and picks up
// schedule changes by itself. Android / Outlook / Google Calendar add it by URL.
//
// The schedule is public on the site, so this needs no password. The events are built by
// ../ics.js, the same module the mobile page uses for "Download file", so IDs match.
// Approved removal requests are left out, like on the page. If the removal store cannot be
// read, the feed is still served without that filter.
//
// Needs schedule-data.js in the function bundle (see "functions" in vercel.json).

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ics = require('../ics.js');
const removals = require('./removal-request');

function loadPeriods() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'schedule-data.js'), 'utf8');
  const code = src.replace(/^\s*export\s+(const|let|var)\s+PERIODS\b/m, '$1 PERIODS') + '\n;PERIODS;';
  return vm.runInNewContext(code, Object.create(null), { timeout: 500 });
}

async function approvedRemovals() {
  const out = new Set();
  try {
    const data = await removals.overlay(removals.config());
    (data.removals || []).forEach(r => { if (r.status === 'approved') out.add(r.period + '||' + r.offset + '||' + r.name); });
  } catch { /* serve the feed without the filter */ }
  return out;
}

function sendText(res, code, body) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(body);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, 'Use GET.');
  const url = new URL(req.url, 'http://localhost');
  const asked = (url.searchParams.get('name') || '').trim().slice(0, 80);
  if (!asked) return sendText(res, 400, 'Add ?name= with a name from the schedule.');

  let periods;
  try { periods = loadPeriods(); } catch { return sendText(res, 500, 'The schedule could not be read.'); }
  const name = ics.names(periods).find(n => n.toLowerCase() === asked.toLowerCase());
  if (!name) return sendText(res, 404, 'No schedule found for that name.');

  const body = ics.text(periods, name, { removed: await approvedRemovals(), subscribe: true });
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', `inline; filename="tmh-shifts-${ics.slug(name)}.ics"`);
  // Edge cache for 15 minutes so many phones refreshing do not each rebuild the feed.
  res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=900, stale-while-revalidate=3600');
  res.end(req.method === 'HEAD' ? '' : body);
};
