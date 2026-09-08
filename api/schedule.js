// Vercel serverless function behind the schedule console at /admin.
//
// The console posts new copies of the schedule files here. This function checks
// them, then commits them to the GitHub repository in one commit. Vercel (and the
// GitHub Pages workflow) deploy the new commit automatically.
//
// Environment variables (set them in the Vercel project settings):
//   ADMIN_PASSWORD      required. The console asks for this password.
//   GITHUB_TOKEN        required. Fine-grained token with "Contents: read and write"
//                       on the repository.
//   GITHUB_REPO         optional. "owner/name". Defaults to the linked Vercel repo.
//   GITHUB_BRANCH       optional. Defaults to "main".
//   SCHEDULE_DATA_PATH  optional. Defaults to "schedule-data.js".
//   DESKTOP_PAGE_PATH   optional. Defaults to "index.html".
//   MOBILE_PAGE_PATH    optional. Defaults to "mobile.html".

'use strict';

const crypto = require('crypto');
const vm = require('vm');
const inspect = require('../admin/inspect.js');

const HISTORY_LIMIT = 12;
const ROLES = ['data', 'desktop', 'mobile'];

function config() {
  const owner = process.env.VERCEL_GIT_REPO_OWNER || 'gageabass-jpg';
  const slug = process.env.VERCEL_GIT_REPO_SLUG || 'publicworx';
  return {
    repo: process.env.GITHUB_REPO || `${owner}/${slug}`,
    branch: process.env.GITHUB_BRANCH || 'main',
    paths: {
      data: process.env.SCHEDULE_DATA_PATH || 'schedule-data.js',
      desktop: process.env.DESKTOP_PAGE_PATH || 'index.html',
      mobile: process.env.MOBILE_PAGE_PATH || 'mobile.html',
    },
    token: process.env.GITHUB_TOKEN || '',
    password: process.env.ADMIN_PASSWORD || '',
    // Hide commits before the schedule project began (the repo's earlier life as the
    // Clancy Trial Tracker). Override with HISTORY_SINCE (ISO date) if ever needed.
    historySince: process.env.HISTORY_SINCE || '2026-09-01T00:00:00Z',
  };
}

// Runs the data file in an empty sandbox with a time limit and returns PERIODS.
const evaluator = code => vm.runInNewContext(code, Object.create(null), { timeout: 500 });
const check = (role, text) => inspect.inspect(role, text, evaluator);

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

// ---------- GitHub ----------
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
    const err = new Error(`GitHub: ${(data && data.message) || `returned ${res.status}`}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

const gitBlobSha = text => {
  const buf = Buffer.from(text, 'utf8');
  return crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
};

function decodeContent(entry) {
  if (!entry || entry.encoding !== 'base64') throw new Error('GitHub returned a file in an unexpected format.');
  return Buffer.from(entry.content.replace(/\n/g, ''), 'base64').toString('utf8');
}

async function readFile(cfg, path, ref) {
  try {
    const entry = await gh(cfg, 'GET', `/repos/${cfg.repo}/contents/${path}?ref=${encodeURIComponent(ref || cfg.branch)}`);
    return { sha: entry.sha, text: decodeContent(entry), size: entry.size };
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

async function commitsFor(cfg, path) {
  const since = cfg.historySince ? `&since=${encodeURIComponent(cfg.historySince)}` : '';
  const list = await gh(cfg, 'GET', `/repos/${cfg.repo}/commits?path=${encodeURIComponent(path)}&sha=${encodeURIComponent(cfg.branch)}&per_page=${HISTORY_LIMIT}${since}`);
  return Array.isArray(list) ? list : [];
}

async function history(cfg) {
  const lists = await Promise.all(ROLES.map(r => commitsFor(cfg, cfg.paths[r])));
  const byShaMap = new Map();
  lists.forEach((list, i) => list.forEach(c => {
    const cur = byShaMap.get(c.sha) || {
      sha: c.sha, short: c.sha.slice(0, 7),
      message: ((c.commit && c.commit.message) || '').split('\n')[0],
      date: (c.commit && c.commit.author && c.commit.author.date) || null,
      author: (c.commit && c.commit.author && c.commit.author.name) || (c.author && c.author.login) || '',
      url: c.html_url, files: [],
    };
    cur.files.push(cfg.paths[ROLES[i]]);
    byShaMap.set(c.sha, cur);
  }));
  return [...byShaMap.values()].sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, HISTORY_LIMIT);
}

async function status(cfg) {
  const [files, commits] = await Promise.all([
    Promise.all(ROLES.map(r => readFile(cfg, cfg.paths[r]))),
    history(cfg),
  ]);
  const live = {};
  ROLES.forEach((r, i) => {
    const f = files[i];
    if (!f) { live[r] = { path: cfg.paths[r], missing: true }; return; }
    const report = check(r, f.text);
    const last = commits.find(c => c.files.includes(cfg.paths[r])) || null;
    live[r] = { path: cfg.paths[r], sha: f.sha, bytes: report.bytes, ok: report.ok, errors: report.errors, warnings: report.warnings, periods: report.periods || null, lastCommit: last };
  });
  return {
    target: { repo: cfg.repo, branch: cfg.branch, url: `https://github.com/${cfg.repo}/tree/${cfg.branch}`, paths: cfg.paths },
    live,
    history: commits,
  };
}

// Writes several files in one commit through the Git Data API. `files` is { path: text }.
async function commitFiles(cfg, files, message) {
  const ref = await gh(cfg, 'GET', `/repos/${cfg.repo}/git/ref/heads/${encodeURIComponent(cfg.branch)}`);
  const headSha = ref.object.sha;
  const head = await gh(cfg, 'GET', `/repos/${cfg.repo}/git/commits/${headSha}`);
  const tree = await gh(cfg, 'GET', `/repos/${cfg.repo}/git/trees/${head.tree.sha}?recursive=1`);
  const existing = new Map((tree.tree || []).map(e => [e.path, e.sha]));

  const changed = Object.entries(files).filter(([path, text]) => existing.get(path) !== gitBlobSha(text));
  if (!changed.length) {
    const err = new Error('Every file is identical to the live copy. Nothing to publish.');
    err.status = 409;
    throw err;
  }
  const entries = [];
  for (const [path, text] of changed) {
    const blob = await gh(cfg, 'POST', `/repos/${cfg.repo}/git/blobs`, { content: Buffer.from(text, 'utf8').toString('base64'), encoding: 'base64' });
    entries.push({ path, mode: '100644', type: 'blob', sha: blob.sha });
  }
  const newTree = await gh(cfg, 'POST', `/repos/${cfg.repo}/git/trees`, { base_tree: head.tree.sha, tree: entries });
  const commit = await gh(cfg, 'POST', `/repos/${cfg.repo}/git/commits`, { message, tree: newTree.sha, parents: [headSha] });
  await gh(cfg, 'PATCH', `/repos/${cfg.repo}/git/refs/heads/${encodeURIComponent(cfg.branch)}`, { sha: commit.sha, force: false });
  return { sha: commit.sha, short: commit.sha.slice(0, 7), url: commit.html_url || `https://github.com/${cfg.repo}/commit/${commit.sha}`, files: changed.map(([p]) => p) };
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
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

async function publish(cfg, body) {
  const staged = body.files && typeof body.files === 'object' ? body.files : {};
  const reports = {};
  const toWrite = {};
  let bad = false;
  for (const role of ROLES) {
    if (typeof staged[role] !== 'string') continue;
    const detected = inspect.classify(staged[role], '');
    if (detected !== role && !(role === 'data' && detected === 'unknown')) {
      reports[role] = { role, ok: false, errors: [`This file looks like the ${detected === 'legacy' ? 'old inline-data page' : detected} file, not the ${role} file.`], warnings: [] };
      bad = true;
      continue;
    }
    const report = check(role, staged[role]);
    reports[role] = report;
    if (!report.ok) { bad = true; continue; }
    toWrite[cfg.paths[role]] = role === 'data' ? staged[role] : report.html;
    delete report.html;
  }
  if (!Object.keys(reports).length) return { code: 400, payload: { error: 'No files to publish.' } };
  if (bad && !body.force) return { code: 422, payload: { error: 'A file did not pass the checks.', reports } };
  const dataReport = reports.data;
  const titles = dataReport && dataReport.periods ? dataReport.periods.map(p => p.title).join(', ') : '';
  const names = Object.keys(toWrite).join(', ');
  const message = (body.message && String(body.message).trim()) || (titles ? `Publish schedule: ${titles}` : `Publish ${names}`);
  const commit = await commitFiles(cfg, toWrite, message);
  return { code: 200, payload: { ok: true, commit, reports } };
}

async function restore(cfg, ref) {
  const files = {};
  const reports = {};
  for (const role of ROLES) {
    const f = await readFile(cfg, cfg.paths[role], ref);
    if (!f) continue;
    files[cfg.paths[role]] = f.text;
    const r = check(role, f.text); delete r.html; reports[role] = r;
  }
  if (!Object.keys(files).length) return { code: 404, payload: { error: 'That commit has none of the schedule files.' } };
  const commit = await commitFiles(cfg, files, `Restore schedule files from ${ref.slice(0, 7)}`);
  return { code: 200, payload: { ok: true, commit, reports } };
}

async function handler(req, res) {
  const cfg = config();
  const url = new URL(req.url, 'http://localhost');
  const op = url.searchParams.get('op') || '';

  if (req.method === 'GET' && op === 'health') {
    return send(res, 200, { ok: true, configured: { password: !!cfg.password, token: !!cfg.token }, target: { repo: cfg.repo, branch: cfg.branch, paths: cfg.paths } });
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
      if (action === 'publish') { const r = await publish(cfg, body); return send(res, r.code, r.payload); }
      if (action === 'restore') {
        const ref = String(body.ref || '');
        if (!/^[0-9a-f]{7,40}$/i.test(ref)) return send(res, 400, { error: 'A commit SHA is required.' });
        const r = await restore(cfg, ref); return send(res, r.code, r.payload);
      }
    }
    return send(res, 404, { error: 'Unknown operation.' });
  } catch (err) {
    const code = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
    // A 401/403 from GitHub means the token is wrong, not the console password.
    return send(res, code === 401 || code === 403 ? 502 : code, { error: err.message || 'Unexpected error.' });
  }
}

module.exports = handler;
