// Vercel serverless function: publishes new copies of the schedule page.
//
// The console at /admin posts the exported schedule HTML here. This function
// checks the file, then commits it to the GitHub repository. Vercel (and the
// GitHub Pages workflow) deploy the new commit automatically.
//
// Environment variables (set them in the Vercel project settings):
//   ADMIN_PASSWORD   required. The console asks for this password.
//   GITHUB_TOKEN     required. Fine-grained token with "Contents: read and write"
//                    on the repository.
//   GITHUB_REPO      optional. "owner/name". Defaults to the linked Vercel repo.
//   GITHUB_BRANCH    optional. Defaults to the production branch ("main").
//   SCHEDULE_PATH    optional. File to replace. Defaults to "index.html".

'use strict';

const crypto = require('crypto');

const MAX_BYTES = 2 * 1024 * 1024;
const HISTORY_LIMIT = 12;

function config() {
  const owner = process.env.VERCEL_GIT_REPO_OWNER || 'gageabass-jpg';
  const slug = process.env.VERCEL_GIT_REPO_SLUG || 'publicworx';
  return {
    repo: process.env.GITHUB_REPO || `${owner}/${slug}`,
    branch: process.env.GITHUB_BRANCH || 'main',
    path: process.env.SCHEDULE_PATH || 'index.html',
    token: process.env.GITHUB_TOKEN || '',
    password: process.env.ADMIN_PASSWORD || '',
  };
}

// Reads the PERIODS array out of an exported schedule page and reports what it
// finds. Returns { ok, errors, warnings, periods, bytes }.
function inspectSchedule(html) {
  const errors = [];
  const warnings = [];
  const periods = [];
  if (typeof html !== 'string' || !html.length) {
    return { ok: false, errors: ['The file is empty.'], warnings, periods, bytes: 0 };
  }
  const bytes = Buffer.byteLength(html, 'utf8');
  if (bytes > MAX_BYTES) errors.push(`The file is ${(bytes / 1048576).toFixed(1)} MB. The limit is 2 MB.`);
  if (!/<x-dc[\s>]/.test(html) || !html.includes('</x-dc>')) errors.push('No <x-dc> block. This is not an exported schedule page.');
  if (!/data-dc-script/.test(html)) errors.push('No data-dc-script block. The page has no logic script.');

  const startIdx = html.indexOf('const PERIODS = [');
  if (startIdx === -1) {
    errors.push('No PERIODS array. The page has no schedule data.');
  } else {
    const endIdx = html.indexOf('\n];', startIdx);
    const block = html.slice(startIdx, endIdx === -1 ? undefined : endIdx);
    const re = /\{\s*label:\s*'((?:[^'\\]|\\.)*)'\s*,\s*title:\s*'((?:[^'\\]|\\.)*)'\s*,\s*start:\s*\[\s*(\d{4})\s*,\s*(\d{1,2})\s*,\s*(\d{1,2})\s*\]/g;
    const heads = [];
    let m;
    while ((m = re.exec(block))) heads.push({ index: m.index, label: m[1], title: m[2], start: [+m[3], +m[4], +m[5]] });
    heads.forEach((h, i) => {
      const chunk = block.slice(h.index, i + 1 < heads.length ? heads[i + 1].index : undefined);
      const sections = (chunk.match(/\[\s*'[^']+'\s*,\s*\[\s*\n/g) || []).length;
      const people = (chunk.match(/^\s*\[\s*'[^']+'\s*,\s*'[^']*'/gm) || []).length;
      const y = h.start[0], mo = h.start[1], d = h.start[2];
      const startDate = new Date(Date.UTC(y, mo, d));
      const badDate = mo < 0 || mo > 11 || d < 1 || d > 31 || Number.isNaN(startDate.getTime());
      if (badDate) warnings.push(`Period "${h.title}" has a start date that does not look right: [${y}, ${mo}, ${d}].`);
      if (!people) warnings.push(`Period "${h.title}" has no staff rows.`);
      periods.push({ label: h.label, title: h.title, start: h.start, startIso: badDate ? null : startDate.toISOString().slice(0, 10), sections, people });
    });
    if (!heads.length) errors.push('The PERIODS array has no periods with a label, title and start date.');
  }

  if (!/support\.js/.test(html)) warnings.push('The page does not load support.js. It will not render unless the runtime is inlined.');
  if (/<script[^>]+src=["']https?:\/\/(?!unpkg\.com\/)/i.test(html)) warnings.push('The page loads a script from an unexpected host.');

  return { ok: errors.length === 0, errors, warnings, periods, bytes };
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

async function gh(cfg, method, url, body) {
  const res = await fetch(`https://api.github.com${url}`, {
    method,
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'tmh-schedule-console',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) {
    const msg = (data && data.message) || `GitHub returned ${res.status}`;
    const err = new Error(`GitHub: ${msg}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function decodeContent(entry) {
  if (!entry || entry.encoding !== 'base64') throw new Error('GitHub returned the file in an unexpected format.');
  return Buffer.from(entry.content.replace(/\n/g, ''), 'base64').toString('utf8');
}

async function readLive(cfg, ref) {
  const q = ref ? `?ref=${encodeURIComponent(ref)}` : `?ref=${encodeURIComponent(cfg.branch)}`;
  const entry = await gh(cfg, 'GET', `/repos/${cfg.repo}/contents/${cfg.path}${q}`);
  return { sha: entry.sha, html: decodeContent(entry), size: entry.size };
}

async function history(cfg) {
  const list = await gh(cfg, 'GET', `/repos/${cfg.repo}/commits?path=${encodeURIComponent(cfg.path)}&sha=${encodeURIComponent(cfg.branch)}&per_page=${HISTORY_LIMIT}`);
  return (Array.isArray(list) ? list : []).map(c => ({
    sha: c.sha,
    short: c.sha.slice(0, 7),
    message: (c.commit && c.commit.message || '').split('\n')[0],
    date: c.commit && c.commit.author && c.commit.author.date || null,
    author: (c.commit && c.commit.author && c.commit.author.name) || (c.author && c.author.login) || '',
    url: c.html_url,
  }));
}

async function status(cfg) {
  const [live, commits] = await Promise.all([readLive(cfg), history(cfg)]);
  const report = inspectSchedule(live.html);
  return {
    target: { repo: cfg.repo, branch: cfg.branch, path: cfg.path, url: `https://github.com/${cfg.repo}/blob/${cfg.branch}/${cfg.path}` },
    live: { sha: live.sha, bytes: report.bytes, periods: report.periods, warnings: report.warnings, errors: report.errors, lastCommit: commits[0] || null },
    history: commits,
  };
}

async function writeFile(cfg, html, message) {
  const current = await gh(cfg, 'GET', `/repos/${cfg.repo}/contents/${cfg.path}?ref=${encodeURIComponent(cfg.branch)}`).catch(err => {
    if (err.status === 404) return null;
    throw err;
  });
  if (current && decodeContent(current) === html) {
    const err = new Error('This copy is identical to the live schedule. Nothing to publish.');
    err.status = 409;
    throw err;
  }
  const body = {
    message,
    content: Buffer.from(html, 'utf8').toString('base64'),
    branch: cfg.branch,
    ...(current ? { sha: current.sha } : {}),
  };
  const out = await gh(cfg, 'PUT', `/repos/${cfg.repo}/contents/${cfg.path}`, body);
  return { sha: out.commit.sha, short: out.commit.sha.slice(0, 7), url: out.commit.html_url, fileSha: out.content && out.content.sha };
}

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
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

async function handler(req, res) {
  const cfg = config();
  const url = new URL(req.url, 'http://localhost');
  const op = url.searchParams.get('op') || '';

  if (req.method === 'GET' && op === 'health') {
    return send(res, 200, { ok: true, configured: { password: !!cfg.password, token: !!cfg.token }, target: { repo: cfg.repo, branch: cfg.branch, path: cfg.path } });
  }
  if (!cfg.password || !cfg.token) {
    return send(res, 503, { error: 'The console is not configured. Set ADMIN_PASSWORD and GITHUB_TOKEN in the Vercel project settings, then redeploy.' });
  }
  if (!authorized(req, cfg)) return send(res, 401, { error: 'Wrong password.' });

  try {
    if (req.method === 'GET' && op === 'status') return send(res, 200, await status(cfg));

    if (req.method === 'POST') {
      const body = await readBody(req);
      const action = body.op || op;

      if (action === 'inspect') {
        return send(res, 200, inspectSchedule(String(body.html || '')));
      }

      if (action === 'publish') {
        const html = String(body.html || '');
        const report = inspectSchedule(html);
        if (!report.ok && !body.force) return send(res, 422, { error: 'The file did not pass the checks.', report });
        const titles = report.periods.map(p => p.title).join(', ');
        const message = (body.message && String(body.message).trim()) || `Publish schedule: ${titles || 'new copy'}`;
        const commit = await writeFile(cfg, html, message);
        return send(res, 200, { ok: true, commit, report });
      }

      if (action === 'restore') {
        const ref = String(body.ref || '');
        if (!/^[0-9a-f]{7,40}$/i.test(ref)) return send(res, 400, { error: 'A commit SHA is required.' });
        const old = await readLive(cfg, ref);
        const report = inspectSchedule(old.html);
        const commit = await writeFile(cfg, old.html, `Restore schedule from ${ref.slice(0, 7)}`);
        return send(res, 200, { ok: true, commit, report });
      }
    }
    return send(res, 404, { error: 'Unknown operation.' });
  } catch (err) {
    const code = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
    return send(res, code === 401 || code === 403 ? 502 : code, { error: err.message || 'Unexpected error.' });
  }
}

module.exports = handler;
module.exports.inspectSchedule = inspectSchedule;
