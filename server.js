// Minimal dev server: serves static files from the repo root and wraps the
// Vercel-style serverless function at /api/schedule. No build step needed.
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const scheduleHandler = require('./api/schedule');

const ROOT = __dirname;
const PORT = process.env.PORT || 3000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, urlPath) {
  let filePath = path.join(ROOT, decodeURIComponent(urlPath));
  if (urlPath.endsWith('/')) filePath = path.join(filePath, 'index.html');
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      // Fall back to index.html for clean URLs
      if (!path.extname(urlPath)) {
        filePath = path.join(ROOT, urlPath, 'index.html');
        fs.stat(filePath, (e2, s2) => {
          if (e2 || !s2.isFile()) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not found');
            return;
          }
          serveFile(res, filePath);
        });
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    serveFile(res, filePath);
  });
}

function serveFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  if (pathname === '/api/schedule') {
    // Adapt: the Vercel handler expects req.url to be the full path with query
    req.url = req.url;
    return scheduleHandler(req, res);
  }

  serveStatic(req, res, pathname);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Schedule Stream dev server on http://0.0.0.0:${PORT}`);
});
