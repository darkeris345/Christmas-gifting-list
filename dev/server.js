'use strict';
// Local dev server: serves /public and runs the real API handler against an
// in-memory fake of Redis. Nothing is saved when it stops.
// Usage: node dev/server.js   (then open http://localhost:3000)

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

process.env.KV_REST_API_URL = 'https://fake-redis.local';
process.env.KV_REST_API_TOKEN = 'dev-token';

const store = new Map();
function run([cmd, key, ...args]) {
  const hash = () => store.get(key) || store.set(key, new Map()).get(key);
  switch (cmd) {
    case 'HGET': return hash().get(args[0]) ?? null;
    case 'HGETALL': return [...hash().entries()].flat();
    case 'HSET': { const had = hash().has(args[0]); hash().set(args[0], args[1]); return had ? 0 : 1; }
    case 'HDEL': return hash().delete(args[0]) ? 1 : 0;
    case 'HLEN': return hash().size;
    case 'DEL': return store.delete(key) ? 1 : 0;
    case 'EXPIRE': return 1;
    case 'PING': return 'PONG';
    default: throw new Error(`fake redis: unsupported ${cmd}`);
  }
}
global.fetch = async (_url, init) => {
  const results = JSON.parse(init.body).map((c) => {
    try { return { result: run(c) }; } catch (e) { return { error: e.message }; }
  });
  return { ok: true, status: 200, json: async () => results };
};

const handler = require('../api/room.js');
const healthHandler = require('../api/health.js');

// Apply the same response headers as vercel.json (including the Content-Security-Policy),
// so anything the policy would block on Vercel also fails here.
const SECURITY_HEADERS = (() => {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8'));
    return (cfg.headers || []).flatMap((rule) => rule.headers || []);
  } catch (_) { return []; }
})();
const PUBLIC = path.join(__dirname, '..', 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript' };

http.createServer((req, res) => {
  for (const { key, value } of SECURITY_HEADERS) res.setHeader(key, value);
  if (req.url.startsWith('/api/health')) {
    const shim = {
      setHeader: (k, v) => res.setHeader(k, v),
      status(code) { res.statusCode = code; return this; },
      json(obj) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(obj)); },
    };
    healthHandler({ method: req.method }, shim);
    return;
  }
  if (req.url.startsWith('/api/room')) {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body;
      try { body = JSON.parse(raw); } catch (_) { body = raw; }
      const shim = {
        setHeader: (k, v) => res.setHeader(k, v),
        status(code) { res.statusCode = code; return this; },
        json(obj) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(obj)); },
      };
      handler({ method: req.method, body }, shim);
    });
    return;
  }
  const name = req.url.split('?')[0] === '/' ? 'index.html' : path.basename(req.url.split('?')[0]);
  const file = path.join(PUBLIC, name);
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file)) { res.statusCode = 404; return res.end('Not found'); }
  res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
  res.end(fs.readFileSync(file));
}).listen(process.env.PORT || 3000, () => console.log(`http://localhost:${process.env.PORT || 3000}`));
