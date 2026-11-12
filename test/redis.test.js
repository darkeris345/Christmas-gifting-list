'use strict';
// Tests for finding the Redis settings, classifying database failures, and /api/health.
// Usage: node test/redis.test.js

const assert = require('node:assert/strict');
const { findCredentials, pipeline, RedisError } = require('../lib/redis.js');
const room = require('../api/room.js');
const health = require('../api/health.js');

let passed = 0;
async function test(name, fn) {
  const saved = { ...process.env };
  for (const key of Object.keys(process.env)) {
    if (/REST|REDIS|^KV_/.test(key)) delete process.env[key];
  }
  try { await fn(); } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, saved);
  }
  passed += 1;
  console.log(`ok - ${name}`);
}

const URL_A = 'https://example-a.upstash.io';
const URL_B = 'https://example-b.upstash.io';

function fakeResponse() {
  return {
    statusCode: 200, headers: {}, body: null,
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
  };
}
const callRoom = async (body) => { const res = fakeResponse(); await room({ method: 'POST', body }, res); return res; };
const callHealth = async (method = 'GET') => { const res = fakeResponse(); await health({ method }, res); return res; };

(async () => {
  await test('finds the names Vercel and Upstash normally use', () => {
    assert.deepEqual(findCredentials({ KV_REST_API_URL: URL_A, KV_REST_API_TOKEN: 't1' }), { url: URL_A, token: 't1' });
    assert.deepEqual(findCredentials({ UPSTASH_REDIS_REST_URL: URL_A, UPSTASH_REDIS_REST_TOKEN: 't2' }), { url: URL_A, token: 't2' });
  });

  await test('finds settings under a custom prefix chosen when connecting the database', () => {
    assert.deepEqual(findCredentials({ STORAGE_KV_REST_API_URL: URL_A, STORAGE_KV_REST_API_TOKEN: 't3' }), { url: URL_A, token: 't3' });
    assert.deepEqual(findCredentials({ STORAGE_REST_API_URL: URL_A, STORAGE_REST_API_TOKEN: 't4' }), { url: URL_A, token: 't4' });
    assert.deepEqual(findCredentials({ MYAPP_UPSTASH_REDIS_REST_URL: URL_A, MYAPP_UPSTASH_REDIS_REST_TOKEN: 't5' }), { url: URL_A, token: 't5' });
  });

  await test('never uses the read-only token, and needs a matching token for the URL', () => {
    assert.throws(() => findCredentials({ KV_REST_API_URL: URL_A, KV_REST_API_READ_ONLY_TOKEN: 'ro' }), RedisError);
    const env = { KV_REST_API_URL: URL_A, KV_REST_API_TOKEN: 'rw', KV_REST_API_READ_ONLY_TOKEN: 'ro' };
    assert.equal(findCredentials(env).token, 'rw');
    assert.throws(() => findCredentials({ KV_REST_API_URL: URL_A, OTHER_REST_API_TOKEN: 'x' }), RedisError); // mismatched prefix
  });

  await test('prefers the standard names when several databases are present; trims a trailing slash', () => {
    const env = { AAA_REST_API_URL: URL_B, AAA_REST_API_TOKEN: 'b', KV_REST_API_URL: `${URL_A}/`, KV_REST_API_TOKEN: 'a' };
    assert.deepEqual(findCredentials(env), { url: URL_A, token: 'a' });
  });

  await test('ignores values that are not web addresses', () => {
    assert.throws(() => findCredentials({ KV_REST_API_URL: 'rediss://default:pw@host:6379', KV_REST_API_TOKEN: 't' }), RedisError);
    assert.throws(() => findCredentials({ KV_REST_API_URL: '', KV_REST_API_TOKEN: 't' }), RedisError);
  });

  await test('nothing configured: explains it, and notices a plain REDIS_URL', () => {
    let err;
    try { findCredentials({}); } catch (e) { err = e; }
    assert.ok(err instanceof RedisError);
    assert.equal(err.kind, 'not-configured');
    assert.equal(err.plainUrl, false);
    try { findCredentials({ REDIS_URL: 'redis://x' }); } catch (e) { err = e; }
    assert.equal(err.plainUrl, true);
  });

  await test('database failures are classified', async () => {
    process.env.KV_REST_API_URL = URL_A;
    process.env.KV_REST_API_TOKEN = 'tok';
    const kindOf = async () => { try { await pipeline([['PING']]); } catch (e) { return e.kind; } return 'none'; };

    global.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) });
    assert.equal(await kindOf(), 'rejected');
    global.fetch = async () => ({ ok: false, status: 403, json: async () => ({}) });
    assert.equal(await kindOf(), 'rejected');
    global.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) });
    assert.equal(await kindOf(), 'unreachable');
    global.fetch = async () => { throw new Error('getaddrinfo ENOTFOUND'); };
    assert.equal(await kindOf(), 'unreachable');
    global.fetch = async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } });
    assert.equal(await kindOf(), 'unreachable');
    global.fetch = async () => ({ ok: true, status: 200, json: async () => [{ error: 'ERR wrong' }] });
    assert.equal(await kindOf(), 'command');
    global.fetch = async () => ({ ok: true, status: 200, json: async () => [{ result: 'PONG' }] });
    assert.equal(await kindOf(), 'none');
  });

  await test('the API explains database problems instead of a vague error, without leaking details', async () => {
    const ask = () => callRoom({ room: 'xmas-abcde-fghij', me: 'Sam', action: 'join' });

    let res = await ask(); // nothing configured
    assert.equal(res.statusCode, 503);
    assert.match(res.body.error, /isn’t connected to its database/);

    process.env.KV_REST_API_URL = URL_A;
    process.env.KV_REST_API_TOKEN = 'secret-token-value';
    global.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) });
    res = await ask();
    assert.equal(res.statusCode, 503);
    assert.match(res.body.error, /refused the connection/);

    global.fetch = async () => { throw new Error(`connect ECONNREFUSED ${URL_A}`); };
    res = await ask();
    assert.equal(res.statusCode, 503);
    assert.match(res.body.error, /can’t reach its database/);
    for (const text of [JSON.stringify(res.body)]) {
      assert.ok(!text.includes('upstash') && !text.includes('secret-token-value') && !text.includes('ECONNREFUSED'));
    }

    global.fetch = async () => ({ ok: true, status: 200, json: async () => [{ error: 'ERR something odd' }] });
    res = await ask();
    assert.equal(res.statusCode, 500); // anything else stays a generic message
    assert.equal(res.body.error, 'Something went wrong on the server. Try again.');
  });

  await test('/api/health reports connected, and each kind of problem, with no secrets', async () => {
    let res = await callHealth();
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.problem, 'not-configured');
    assert.match(res.body.hint, /Upstash for Redis/);

    process.env.REDIS_URL = 'redis://default:pw@host:6379';
    res = await callHealth();
    assert.match(res.body.hint, /plain Redis URL/);
    delete process.env.REDIS_URL;

    process.env.KV_REST_API_URL = URL_A;
    process.env.KV_REST_API_TOKEN = 'secret-token-value';
    global.fetch = async () => ({ ok: true, status: 200, json: async () => [{ result: 'PONG' }] });
    res = await callHealth();
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { ok: true, database: 'connected' });

    global.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) });
    res = await callHealth();
    assert.equal(res.body.problem, 'rejected');

    global.fetch = async () => { throw new Error(`getaddrinfo ENOTFOUND ${URL_A}`); };
    res = await callHealth();
    assert.equal(res.body.problem, 'unreachable');
    assert.ok(!JSON.stringify(res.body).includes('upstash') && !JSON.stringify(res.body).includes('secret'));

    assert.equal((await callHealth('POST')).statusCode, 405);
  });

  console.log(`\n${passed} database-connection tests passed`);
})().catch((err) => { console.error(err); process.exit(1); });
