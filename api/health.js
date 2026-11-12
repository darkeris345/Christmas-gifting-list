'use strict';

// GET /api/health: tells whoever set up the site whether the database is connected,
// and if not, why. It never reveals keys, addresses or any stored data.

const { command, RedisError } = require('../lib/redis');

const HINTS = {
  'not-configured': 'No Redis connection found. In Vercel open the project, go to Storage, add "Upstash for Redis", connect it to this project, then redeploy.',
  'plain-url': 'A plain Redis URL was found, but this app needs the REST URL and token. Connect "Upstash for Redis" from the Vercel Storage tab, then redeploy.',
  rejected: 'The database refused the connection. Check that the Redis token in the project’s environment variables is current, then redeploy.',
  unreachable: 'The database could not be reached. Check that it still exists in Upstash, and try again in a minute.',
  error: 'The database check failed for another reason. See the function logs in Vercel.',
};

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    return res.status(405).json({ ok: false, error: 'Method not allowed.' });
  }
  try {
    const reply = await command('PING');
    if (reply === 'PONG') return res.status(200).json({ ok: true, database: 'connected' });
    return res.status(503).json({ ok: false, problem: 'error', hint: HINTS.error });
  } catch (err) {
    const kind = err instanceof RedisError ? err.kind : 'error';
    console.error(`health check: ${kind}: ${err && err.message}`);
    const key = kind === 'not-configured' && err.plainUrl ? 'plain-url' : kind;
    return res.status(503).json({ ok: false, problem: kind, hint: HINTS[key] || HINTS.error });
  }
};
