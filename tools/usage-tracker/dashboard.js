// Dashboard server for the superpowers usage tracker.
//
// Zero-dependency local web UI. Serves a static page and a JSON API that
// re-queries usage.db on every request (so the page's Refresh button
// regenerates the report straight from the database).
//
// Usage:  node dashboard.js [--port 7493] [--open] [--once] [path/to/usage.db]
//   --open   open the dashboard URL in the default browser
//   --once   print the URL and exit after starting (used by tests/automation)
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { platform } from 'node:os';
import { openDb, defaultDbPath, isMainModule } from './db.js';
import { buildReport } from './report.js';

const HERE = dirname(fileURLToPath(import.meta.url));

// Open a URL in the OS default browser, cross-platform, best-effort.
export function openInBrowser(url) {
  const p = platform();
  let cmd; let args;
  if (p === 'darwin') { cmd = 'open'; args = [url]; }
  else if (p === 'win32') { cmd = 'cmd'; args = ['/c', 'start', '', url]; }
  else { cmd = 'xdg-open'; args = [url]; }
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => { /* no browser available; URL is printed anyway */ });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function parseArgs(argv) {
  const a = { port: Number(process.env.SUPERPOWERS_USAGE_PORT) || 7493, db: null, open: false, once: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') a.port = Number(argv[++i]);
    else if (argv[i] === '--open') a.open = true;
    else if (argv[i] === '--once') a.once = true;
    else if (!argv[i].startsWith('--')) a.db = argv[i];
  }
  return a;
}

function report(dbPath, opts) {
  const db = openDb(dbPath);
  try { return buildReport(db, opts); } finally { db.close(); }
}

function send(res, code, type, body) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

// Pull optional `from`/`to` millisecond bounds from the request query string.
// Invalid or missing values are ignored (treated as an open bound).
export function parseRange(url) {
  const q = new URL(url, 'http://localhost').searchParams;
  const numOr = (v) => { if (v == null || v === '') return undefined; const n = Number(v); return Number.isFinite(n) ? n : undefined; };
  return { from: numOr(q.get('from')), to: numOr(q.get('to')) };
}

export function createDashboard(dbPath) {
  return createServer((req, res) => {
    try {
      if (req.url === '/' || req.url === '/index.html') {
        return send(res, 200, 'text/html; charset=utf-8', readFileSync(join(HERE, 'dashboard.html'), 'utf8'));
      }
      if (req.url.startsWith('/api/report')) {
        return send(res, 200, 'application/json; charset=utf-8', JSON.stringify({ ...report(dbPath, parseRange(req.url)), dbPath }));
      }
      send(res, 404, 'text/plain', 'not found');
    } catch (e) {
      send(res, 500, 'application/json', JSON.stringify({ error: String(e && e.message || e) }));
    }
  });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dbPath = args.db || defaultDbPath(process.env);
  const server = createDashboard(dbPath);

  let attemptsLeft = 10;
  server.on('error', (e) => {
    if (e && e.code === 'EADDRINUSE' && attemptsLeft-- > 0) {
      args.port += 1;
      server.listen(args.port);
    } else {
      console.error(`dashboard: ${e && e.message || e}`);
      process.exit(1);
    }
  });

  server.listen(args.port, () => {
    const url = `http://localhost:${args.port}/`;
    console.log(`Superpowers usage dashboard`);
    console.log(`  database : ${dbPath}`);
    console.log(`  open     : ${url}`);
    if (args.open) openInBrowser(url);
    if (args.once) {
      console.log('(--once) server started; leave it running to view the page.');
    } else {
      console.log('Press Ctrl+C to stop.');
    }
  });
}

const isMain = isMainModule(import.meta.url);
if (isMain) main();
