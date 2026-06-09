// Dashboard server for the superpowers usage tracker.
//
// Zero-dependency local web UI. Serves a static page and a JSON API that
// re-queries usage.db on every request (so the page's Refresh button
// regenerates the report straight from the database).
//
// Usage:  node dashboard.js [--port 7493] [path/to/usage.db]
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, defaultDbPath, isMainModule } from './db.js';
import { buildReport } from './report.js';

const HERE = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const a = { port: Number(process.env.SUPERPOWERS_USAGE_PORT) || 7493, db: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') a.port = Number(argv[++i]);
    else if (!argv[i].startsWith('--')) a.db = argv[i];
  }
  return a;
}

function report(dbPath) {
  const db = openDb(dbPath);
  try { return buildReport(db); } finally { db.close(); }
}

function send(res, code, type, body) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

export function createDashboard(dbPath) {
  return createServer((req, res) => {
    try {
      if (req.url === '/' || req.url === '/index.html') {
        return send(res, 200, 'text/html; charset=utf-8', readFileSync(join(HERE, 'dashboard.html'), 'utf8'));
      }
      if (req.url.startsWith('/api/report')) {
        return send(res, 200, 'application/json; charset=utf-8', JSON.stringify({ ...report(dbPath), dbPath }));
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
  server.listen(args.port, () => {
    console.log(`Superpowers usage dashboard`);
    console.log(`  database : ${dbPath}`);
    console.log(`  open     : http://localhost:${args.port}/`);
    console.log('Press Ctrl+C to stop.');
  });
}

const isMain = isMainModule(import.meta.url);
if (isMain) main();
