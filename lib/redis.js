'use strict';
//
// Minimal Upstash Redis REST client with no dependencies.
// Works with the variable names Vercel's Upstash integration sets
// (KV_REST_API_URL / KV_REST_API_TOKEN) or Upstash's own names.

function credentials() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Redis is not configured (missing REST URL or token).');
  return { url: url.replace(/\/+$/, ''), token };
}

// Run several commands in one round trip. Returns an array of results.
async function pipeline(commands) {
  const { url, token } = credentials();
  const res = await fetch(`${url}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands),
  });
  if (!res.ok) throw new Error(`Redis request failed with status ${res.status}`);
  const out = await res.json();
  return out.map((entry) => {
    if (entry && entry.error) throw new Error(`Redis command failed: ${entry.error}`);
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

module.exports = { pipeline, command, toObject };
