// Vercel serverless function for the "live changes" layer.
//
// Stores schedule overrides (call-ins, swaps, sick days, on-call moves) and public
// change suggestions in Vercel KV (Upstash Redis, REST API). The manager's
// schedule-data.js stays the baseline; these records are layered on top at read time
// by overrides.js. Reading live overrides is public (they are display data, as public
// as the schedule itself). Writing an override, and everything about suggestions
// beyond submitting one, requires the console password.
//
// Environment variables (Vercel project settings):
//   ADMIN_PASSWORD        required for writes. Same password as the schedule console.
//   KV_REST_API_URL       required. From the Vercel KV / Upstash integration.
//   KV_REST_API_TOKEN     required. From the same integration.
//   (UPSTASH_REDIS_REST_URL / _TOKEN are accepted as fallbacks.)

'use strict';

const crypto = require('crypto');

const OV_KEY = 'sched:overrides:v1';   // array of live override records
const SG_KEY = 'sched:suggestions:v1'; // array of pending suggestion records
const MAX_OVERRIDES = 2000;
const MAX_SUGGESTIONS = 500;

function config() {
  return {
    password: process.env.ADMIN_PASSWORD || '',
    kvUrl: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '',
    kvToken: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '',
  };
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function authorized(req, cfg) {
  if (!cfg.password) return false;
  const header = req.headers['authorization'] || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
  const given = req.headers['x-admin-password'] || bearer || '';
  return safeEqual(given, cfg.password);
}

// ---------- Vercel KV / Upstash Redis over REST ----------
async function kv(cfg, ...command) {
  const res = await fetch(cfg.kvUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.kvToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  });
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok) {
    const err = new Error((data && data.error) || `KV request failed (${res.status}).`);
    err.status = 502;
    throw err;
  }
  return data ? data.result : null;
}

async function getArr(cfg, key) {
  const raw = await kv(cfg, 'GET', key);
  if (!raw) return [];
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v : []; } catch { return []; }
}
async function setArr(cfg, key, arr) { await kv(cfg, 'SET', key, JSON.stringify(arr)); }

// ---------- validation ----------
const str = (v, max) => (v === null || v === undefined ? '' : String(v)).slice(0, max).trim();
const isKey = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));

// Returns a clean override, or { error } describing the first problem.
function cleanOverride(body) {
  const periodKey = String(body.periodKey || '');
  if (!isKey(periodKey)) return { error: 'periodKey must be a date like 2026-08-30.' };
  const person = str(body.person, 80);
  if (!person) return { error: 'person is required.' };
  const day = Number(body.day);
  if (!Number.isInteger(day) || day < 1 || day > 28) return { error: 'day must be 1 to 28.' };
  const clear = body.code === null || body.code === undefined || body.code === '';
  const code = clear ? null : str(body.code, 40);
  if (!clear && !code) return { error: 'code is required unless clearing the day.' };
  return {
    ok: {
      periodKey, person, day, code,
      section: str(body.section, 60) || undefined,
      note: str(body.note, 120) || undefined,
      reason: str(body.reason, 200) || undefined,
      author: str(body.author, 80) || undefined,
    },
  };
}

const sameCell = (a, b) => a.periodKey === b.periodKey && a.person === b.person && Number(a.day) === Number(b.day);
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex'));

// ---------- operations ----------
async function saveOverride(cfg, body) {
  const c = cleanOverride(body);
  if (c.error) return { code: 400, payload: { error: c.error } };
  const now = new Date().toISOString();
  const list = await getArr(cfg, OV_KEY);
  const idx = list.findIndex(o => sameCell(o, c.ok)); // one override per cell
  let record;
  if (idx >= 0) {
    record = Object.assign({}, list[idx], c.ok, { status: 'live', updatedAt: now });
    list[idx] = record;
  } else {
    if (list.length >= MAX_OVERRIDES) return { code: 507, payload: { error: 'Too many overrides stored. Clear old ones first.' } };
    record = Object.assign({ id: newId(), status: 'live', createdAt: now, updatedAt: now }, c.ok);
    list.push(record);
  }
  await setArr(cfg, OV_KEY, list);
  return { code: 200, payload: { ok: true, override: record } };
}

async function removeOverride(cfg, body) {
  const id = str(body.id, 64);
  const list = await getArr(cfg, OV_KEY);
  let next;
  if (id) next = list.filter(o => o.id !== id);
  else if (isKey(body.periodKey) && body.person && body.day) next = list.filter(o => !sameCell(o, { periodKey: body.periodKey, person: body.person, day: body.day }));
  else return { code: 400, payload: { error: 'Provide an id, or periodKey + person + day.' } };
  if (next.length === list.length) return { code: 404, payload: { error: 'No matching override.' } };
  await setArr(cfg, OV_KEY, next);
  return { code: 200, payload: { ok: true, removed: list.length - next.length } };
}

async function addSuggestion(cfg, body) {
  const c = cleanOverride(body);
  if (c.error) return { code: 400, payload: { error: c.error } };
  const list = await getArr(cfg, SG_KEY);
  if (list.length >= MAX_SUGGESTIONS) return { code: 507, payload: { error: 'The suggestion queue is full. Try again later.' } };
  const record = Object.assign({ id: newId(), status: 'pending', createdAt: new Date().toISOString() }, c.ok);
  list.push(record);
  await setArr(cfg, SG_KEY, list);
  return { code: 200, payload: { ok: true, suggestion: { id: record.id } } };
}

async function resolveSuggestion(cfg, body) {
  const id = str(body.id, 64);
  const action = str(body.action, 16);
  if (!id) return { code: 400, payload: { error: 'A suggestion id is required.' } };
  const list = await getArr(cfg, SG_KEY);
  const found = list.find(s => s.id === id);
  if (!found) return { code: 404, payload: { error: 'No matching suggestion.' } };
  const next = list.filter(s => s.id !== id);
  await setArr(cfg, SG_KEY, next);
  if (action === 'approve') {
    const r = await saveOverride(cfg, found); // promote it to a live override
    return { code: r.code, payload: Object.assign({ resolved: 'approved' }, r.payload) };
  }
  return { code: 200, payload: { ok: true, resolved: 'dismissed' } };
}

// ---------- HTTP ----------
function send(res, code, payload) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
    return req.body;
  }
  return new Promise(resolve => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { raw += chunk; if (raw.length > 100000) req.destroy(); });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

async function handler(req, res) {
  const cfg = config();
  const url = new URL(req.url, 'http://localhost');
  const op = url.searchParams.get('op') || '';

  // Public: health check.
  if (req.method === 'GET' && op === 'health') {
    return send(res, 200, { ok: true, configured: { kv: !!(cfg.kvUrl && cfg.kvToken), password: !!cfg.password } });
  }
  if (!cfg.kvUrl || !cfg.kvToken) {
    return send(res, 503, { error: 'Live changes are not configured. Add a Vercel KV store and set KV_REST_API_URL and KV_REST_API_TOKEN, then redeploy.' });
  }

  try {
    // Public: read live overrides (display data), and submit a suggestion.
    if (req.method === 'GET' && (op === 'live' || op === '')) {
      return send(res, 200, { overrides: await getArr(cfg, OV_KEY) });
    }
    if (req.method === 'POST' && (await peekOp(req)) === 'suggest') {
      const r = await addSuggestion(cfg, req._body);
      return send(res, r.code, r.payload);
    }

    // Everything below requires the console password.
    if (!authorized(req, cfg)) return send(res, 401, { error: 'Wrong password.' });

    if (req.method === 'GET' && op === 'all') {
      const [overrides, suggestions] = await Promise.all([getArr(cfg, OV_KEY), getArr(cfg, SG_KEY)]);
      return send(res, 200, { overrides, suggestions });
    }
    if (req.method === 'POST') {
      const body = req._body || (await readBody(req));
      const action = body.op || op;
      if (action === 'save') { const r = await saveOverride(cfg, body); return send(res, r.code, r.payload); }
      if (action === 'remove') { const r = await removeOverride(cfg, body); return send(res, r.code, r.payload); }
      if (action === 'resolve') { const r = await resolveSuggestion(cfg, body); return send(res, r.code, r.payload); }
    }
    return send(res, 404, { error: 'Unknown operation.' });
  } catch (err) {
    const code = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
    return send(res, code, { error: err.message || 'Unexpected error.' });
  }
}

// Reads the body once and caches it so a public "suggest" can be told apart from
// password-gated writes before the auth check.
async function peekOp(req) {
  if (req.method !== 'POST') return '';
  if (req._body === undefined) req._body = await readBody(req);
  const url = new URL(req.url, 'http://localhost');
  return (req._body && req._body.op) || url.searchParams.get('op') || '';
}

module.exports = handler;
