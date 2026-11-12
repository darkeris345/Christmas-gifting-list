'use strict';

// Minimal Upstash Redis REST client with no dependencies.
//
// The connection settings are found by looking through the environment variables
// rather than expecting one exact name, because Vercel's Upstash integration can
// add a custom prefix to them (for example STORAGE_KV_REST_API_URL).

// kind: 'not-configured' | 'rejected' | 'unreachable' | 'command'
class RedisError extends Error {
  constructor(kind, message, extra) {
    super(message);
    this.kind = kind;
    Object.assign(this, extra || {});
  }
}

// Pairs "<anything>REST_API_URL" with "<same prefix>REST_API_TOKEN" (or the
// REDIS_REST_URL / REDIS_REST_TOKEN spelling). Read-only tokens never match,
// because this app has to write.
function findCredentials(env = process.env) {
  const found = [];
  for (const [name, value] of Object.entries(env)) {
    let tokenName = null;
    if (/REST_API_URL$/.test(name)) tokenName = name.replace(/REST_API_URL$/, 'REST_API_TOKEN');
    else if (/REDIS_REST_URL$/.test(name)) tokenName = name.replace(/REDIS_REST_URL$/, 'REDIS_REST_TOKEN');
    if (!tokenName || !/^https?:\/\//i.test(value || '')) continue;
    if (env[tokenName]) found.push({ name, url: value, token: env[tokenName] });
  }
  if (found.length === 0) {
    const plain = Boolean(env.REDIS_URL || env.KV_URL);
    throw new RedisError(
      'not-configured',
      plain
        ? 'Found a plain Redis URL, but this app needs the REST URL and token (connect "Upstash for Redis").'
        : 'No Redis REST URL and token found in the environment variables.',
      { plainUrl: plain },
    );
  }
  const preferred = ['KV_REST_API_URL', 'UPSTASH_REDIS_REST_URL'];
  found.sort((a, b) => {
    const rank = (x) => (preferred.includes(x.name) ? preferred.indexOf(x.name) : preferred.length);
    return rank(a) - rank(b) || a.name.localeCompare(b.name);
  });
  return { url: found[0].url.replace(/\/+$/, ''), token: found[0].token };
}

// Run several commands in one round trip. Returns an array of results.
async function pipeline(commands) {
  const { url, token } = findCredentials();
  let res;
  try {
    res = await fetch(`${url}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(commands),
    });
  } catch (err) {
    throw new RedisError('unreachable', `Could not reach Redis: ${err && err.message}`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new RedisError('rejected', `Redis refused the token (status ${res.status}).`);
  }
  if (!res.ok) {
    throw new RedisError(res.status >= 500 ? 'unreachable' : 'command', `Redis request failed with status ${res.status}.`);
  }
  let out;
  try {
    out = await res.json();
  } catch (_) {
    throw new RedisError('unreachable', 'Redis sent a reply that could not be read.');
  }
  return out.map((entry) => {
    if (entry && entry.error) throw new RedisError('command', `Redis command failed: ${entry.error}`);
    return entry ? entry.result : null;
  });
}

async function command(...args) {
  const [result] = await pipeline([args]);
  return result;
}

// HGETALL comes back as a flat [field, value, field, value ...] array
// (or an object on some setups). Normalise to a plain object.
function toObject(hash) {
  if (!hash) return {};
  if (Array.isArray(hash)) {
    const out = {};
    for (let i = 0; i < hash.length; i += 2) out[hash[i]] = hash[i + 1];
    return out;
  }
  return typeof hash === 'object' ? hash : {};
}

module.exports = { pipeline, command, toObject, findCredentials, RedisError };
