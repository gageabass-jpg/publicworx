// Vercel serverless function for staff "removal requests" from the mobile view.
//
// Flow:
//   1. On the mobile schedule, tapping the trash button on a day's edit face
//      POSTs a removal request here (no password). We store it as "pending" and
//      email the scheduler so they know to review it.
//   2. Every phone reads the pending/approved list (GET ?op=list) and greys out
//      pending people; approved removals are hidden from the schedule.
//   3. In the admin console the scheduler approves or rejects each request
//      (POST ?op=resolve, guarded by ADMIN_PASSWORD).
//
// Storage: a Redis HASH ("tmh:removals") over the Upstash/Vercel KV REST API.
// Locally (no KV env) it falls back to a JSON file in the OS temp dir so the
// flow can be exercised with `node server.js`.
//
// Environment variables (set in the Vercel project settings):
//   ADMIN_PASSWORD                     required for approve/reject (shared with the console).
//   KV_REST_API_URL / KV_REST_API_TOKEN            Vercel KV (preferred), or
//   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN   Upstash Redis.
//   FORMSPREE_URL      optional. Defaults to the address the discrepancy form uses.

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HASH_KEY = 'tmh:removals';
const FALLBACK_FILE = path.join(os.tmpdir(), 'tmh-removals.json');
const DEFAULT_FORMSPREE = 'https://formspree.io/f/moeqkzvq';

function config() {
  const kvUrl = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
  const kvToken = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
  return {
    password: process.env.ADMIN_PASSWORD || '',
    kvUrl: kvUrl.replace(/\/+$/, ''),
    kvToken,
    formspree: process.env.FORMSPREE_URL || DEFAULT_FORMSPREE,
  };
}

function storageKind(cfg) {
  if (cfg.kvUrl && cfg.kvToken) return 'kv';
  return 'file';
}

// ---------- Redis (Upstash / Vercel KV REST) ----------
// One command as a JSON array in the POST body keeps arbitrary JSON values safe.
async function redis(cfg, command) {
  const res = await fetch(cfg.kvUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.kvToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || (data && data.error)) {
    throw new Error(`KV: ${(data && data.error) || res.status}`);
  }
  return data ? data.result : null;
}

// ---------- storage abstraction ----------
async function readAll(cfg) {
  if (storageKind(cfg) === 'kv') {
    const flat = await redis(cfg, ['HGETALL', HASH_KEY]);
    const out = {};
    if (Array.isArray(flat)) {
      for (let i = 0; i < flat.length; i += 2) {
        try { out[flat[i]] = JSON.parse(flat[i + 1]); } catch { /* skip */ }
      }
    } else if (flat && typeof flat === 'object') {
      for (const k of Object.keys(flat)) { try { out[k] = JSON.parse(flat[k]); } catch { /* skip */ } }
    }
    return out;
  }
  try { return JSON.parse(fs.readFileSync(FALLBACK_FILE, 'utf8')); } catch { return {}; }
}

async function writeOne(cfg, field, value) {
  if (storageKind(cfg) === 'kv') { await redis(cfg, ['HSET', HASH_KEY, field, JSON.stringify(value)]); return; }
  const all = await readAll(cfg); all[field] = value;
  fs.writeFileSync(FALLBACK_FILE, JSON.stringify(all));
}

async function deleteOne(cfg, field) {
  if (storageKind(cfg) === 'kv') { await redis(cfg, ['HDEL', HASH_KEY, field]); return; }
  const all = await readAll(cfg); delete all[field];
  fs.writeFileSync(FALLBACK_FILE, JSON.stringify(all));
}

// ---------- helpers ----------
function fieldFor(period, offset, name) {
  return crypto.createHash('sha1').update(`${period}\n${offset}\n${name}`).digest('hex').slice(0, 20);
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

const clip = (v, n) => String(v == null ? '' : v).slice(0, n);

async function sendEmail(cfg, r) {
  if (!cfg.formspree) return;
  const payload = r.kind === 'discrepancy'
    ? {
        name: r.name,
        message: r.message,
        regarding: r.regarding || r.period,
        period: r.period,
        _subject: `Schedule Stream — discrepancy from ${r.name}`,
        source: 'mobile-discrepancy',
      }
    : {
        name: r.name,
        message: `${r.name} was reported NOT working on ${r.day}${r.time ? ' (' + r.time + ')' : ''}. Review and approve or reject in the schedule console.`,
        regarding: `${r.day} · ${r.name}`,
        period: r.period,
        _subject: `Schedule Stream — removal requested: ${r.name} on ${r.day}`,
        source: 'mobile-removal',
      };
  try {
    await fetch(cfg.formspree, {
      method: 'POST',
      signal: AbortSignal.timeout(4000),
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch { /* email is best-effort */ }
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
    req.on('data', c => { raw += c; });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

// Public overlay: the phone reads only removals, to grey out / hide people.
// Discrepancy report text is NOT exposed here — it stays in the admin inbox.
async function overlay(cfg) {
  const all = await readAll(cfg);
  const removals = Object.entries(all)
    .filter(([, v]) => (v.kind || 'removal') === 'removal')
    .map(([key, v]) => ({ key, period: v.period, offset: v.offset, name: v.name, status: v.status }));
  return { ok: true, removals };
}

// Admin inbox: every item (removals + discrepancy reports), full detail.
async function inbox(cfg) {
  const all = await readAll(cfg);
  const items = Object.entries(all).map(([key, v]) => ({ key, kind: v.kind || 'removal', ...v }));
  return { ok: true, items };
}

// Public: a phone submits a removal request or a discrepancy report.
async function request(cfg, body) {
  const kind = body.kind === 'discrepancy' ? 'discrepancy' : 'removal';
  const now = new Date().toISOString();

  if (kind === 'discrepancy') {
    const name = clip(body.name, 80).trim() || 'Anonymous';
    const message = clip(body.message, 4000).trim();
    if (!message) return { code: 400, payload: { error: 'A message is required.' } };
    const field = 'disc:' + crypto.randomBytes(8).toString('hex');
    const record = {
      kind: 'discrepancy', name, message,
      regarding: clip(body.regarding, 120),
      period: clip(body.period, 120),
      status: 'open', requestedAt: now,
    };
    await writeOne(cfg, field, record);
    await sendEmail(cfg, record);
    return { code: 200, payload: { ok: true, key: field } };
  }

  const period = clip(body.period, 120);
  const offset = parseInt(body.offset, 10);
  const name = clip(body.name, 80).trim();
  if (!period || !name || !(offset >= 1 && offset <= 28)) {
    return { code: 400, payload: { error: 'A period, an offset (1-28) and a name are required.' } };
  }
  const field = fieldFor(period, offset, name);
  const existing = (await readAll(cfg))[field];
  if (existing && existing.status === 'approved') {
    return { code: 200, payload: { ok: true, already: 'approved' } };
  }
  const record = {
    kind: 'removal', period, offset, name,
    day: clip(body.day, 60) || `Day ${offset}`,
    time: clip(body.time, 60),
    status: 'pending', requestedAt: now,
  };
  await writeOne(cfg, field, record);
  await sendEmail(cfg, record);
  return { code: 200, payload: { ok: true, key: field, removal: record } };
}

// Admin: act on an inbox item.
//   removal:     approve (apply the removal) | reject (put back, delete)
//   discrepancy: resolve (mark done, keep) | delete (remove)
async function resolve(cfg, body) {
  const key = clip(body.key, 64);
  const action = clip(body.action, 16);
  if (!key) return { code: 400, payload: { error: 'A request key is required.' } };
  const all = await readAll(cfg);
  const rec = all[key];
  if (!rec) return { code: 404, payload: { error: 'That item no longer exists.' } };
  const now = new Date().toISOString();
  if (action === 'approve') {
    rec.status = 'approved'; rec.resolvedAt = now;
    await writeOne(cfg, key, rec);
    return { code: 200, payload: { ok: true, item: rec } };
  }
  if (action === 'resolve') {
    rec.status = 'resolved'; rec.resolvedAt = now;
    await writeOne(cfg, key, rec);
    return { code: 200, payload: { ok: true, item: rec } };
  }
  if (action === 'reject' || action === 'delete' || action === 'clear') {
    await deleteOne(cfg, key);
    return { code: 200, payload: { ok: true, cleared: key } };
  }
  return { code: 400, payload: { error: 'Unknown action.' } };
}

async function handler(req, res) {
  const cfg = config();
  const url = new URL(req.url, 'http://localhost');
  const op = url.searchParams.get('op') || '';

  if (req.method === 'GET' && op === 'health') {
    return send(res, 200, { ok: true, storage: storageKind(cfg), configured: { password: !!cfg.password, kv: !!(cfg.kvUrl && cfg.kvToken), email: !!cfg.formspree } });
  }

  try {
    if (req.method === 'GET' && (op === 'overlay' || op === 'list' || op === '')) return send(res, 200, await overlay(cfg));
    if (req.method === 'GET' && op === 'inbox') {
      if (!cfg.password) return send(res, 503, { error: 'ADMIN_PASSWORD is not set on the server.' });
      if (!authorized(req, cfg)) return send(res, 401, { error: 'Wrong password.' });
      return send(res, 200, await inbox(cfg));
    }
    if (req.method === 'POST') {
      const body = await readBody(req);
      const action = body.op || op;
      if (action === 'request' || action === '') { const r = await request(cfg, body); return send(res, r.code, r.payload); }
      if (action === 'resolve') {
        if (!cfg.password) return send(res, 503, { error: 'ADMIN_PASSWORD is not set on the server.' });
        if (!authorized(req, cfg)) return send(res, 401, { error: 'Wrong password.' });
        const r = await resolve(cfg, body); return send(res, r.code, r.payload);
      }
    }
    return send(res, 404, { error: 'Unknown operation.' });
  } catch (err) {
    const code = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
    return send(res, code, { error: err.message || 'Unexpected error.' });
  }
}

module.exports = handler;
