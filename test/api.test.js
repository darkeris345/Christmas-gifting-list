'use strict';
// Runs the real handler against an in-memory fake of Upstash's /pipeline endpoint.
// Usage: node test/api.test.js

const assert = require('node:assert/strict');

process.env.KV_REST_API_URL = 'https://fake-redis.local';
process.env.KV_REST_API_TOKEN = 'test-token';

const store = new Map(); // key -> Map(field -> value)
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
    default: throw new Error(`fake redis: unsupported ${cmd}`);
  }
}
global.fetch = async (url, init) => {
  assert.equal(url, 'https://fake-redis.local/pipeline');
  assert.equal(init.headers.Authorization, 'Bearer test-token');
  const results = JSON.parse(init.body).map((c) => {
    try { return { result: run(c) }; } catch (e) { return { error: e.message }; }
  });
  return { ok: true, status: 200, json: async () => results };
};

const handler = require('../api/room.js');

async function call(body, method = 'POST') {
  const res = {
    statusCode: 200, headers: {}, body: null,
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
  };
  await handler({ method, body }, res);
  return res;
}

const ROOM = 'xmas-testroom1';
const as = (me, room = ROOM) => (action, extra = {}) => call({ room, me, action, ...extra });
const names = async (room = ROOM) => (await call({ room, action: 'names' })).body.members;
const sam = as('Sam');
const alex = as('Alex');
const jo = as('Jo');

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

(async () => {
  await test('rejects non-POST and bad room codes', async () => {
    assert.equal((await call({}, 'GET')).statusCode, 405);
    assert.equal((await call({ room: 'short', me: 'Sam', action: 'join' })).statusCode, 400);
    assert.equal((await call({ room: 'bad room code!!', me: 'Sam', action: 'join' })).statusCode, 400);
  });

  await test('nobody can read or write an empty room', async () => {
    assert.equal((await sam('state')).statusCode, 403);
    assert.equal((await sam('add', { text: 'x' })).statusCode, 403);
    assert.equal((await sam('add-member', { name: 'Alex' })).statusCode, 403);
    assert.deepEqual(await names(), []);
  });

  await test('the first person creates the session; case-insensitive rejoin', async () => {
    assert.equal((await sam('join')).body.me, 'Sam');
    assert.equal((await as('SAM')('join')).body.me, 'Sam');
    assert.deepEqual(await names(), ['Sam']);
  });

  await test('a new name can join by adding itself; an existing name just joins', async () => {
    const res = await alex('join');
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.me, 'Alex');
    assert.deepEqual(await names(), ['Alex', 'Sam']);
    assert.equal((await as(' aLEX ')('join')).body.me, 'Alex'); // same person, no duplicate
    assert.deepEqual(await names(), ['Alex', 'Sam']);
    assert.equal((await as('')('join')).statusCode, 400);
    assert.equal((await as('bad\u0007')('join')).statusCode, 400);
  });

  await test('a member can also add people ahead of time; duplicates and strangers are refused', async () => {
    assert.equal((await sam('add-member', { name: 'Pat' })).statusCode, 200);
    assert.equal((await sam('add-member', { name: 'pat' })).statusCode, 409);
    assert.equal((await sam('add-member', { name: '' })).statusCode, 400);
    assert.equal((await sam('add-member', { name: 'bad\u0007' })).statusCode, 400);
    assert.equal((await as('Stranger')('add-member', { name: 'Stranger' })).statusCode, 403);
    assert.equal((await sam('remove-member', { name: 'Pat' })).statusCode, 200);
    assert.deepEqual(await names(), ['Alex', 'Sam']);
  });

  let samItemId;
  await test('adding gifts validates and normalises input', async () => {
    const ok = await sam('add', { text: '  Wool   socks ', link: 'example.com/socks', note: 'size 42' });
    assert.equal(ok.statusCode, 200);
    samItemId = ok.body.id;
    assert.equal((await sam('add', { text: '' })).statusCode, 400);
    assert.equal((await sam('add', { text: 'x', link: 'javascript:alert(1)' })).statusCode, 400);
    assert.equal((await sam('add', { text: 'x', link: 'data:text/html,hi' })).statusCode, 400);
    assert.equal((await sam('add', { text: 'x'.repeat(121) })).statusCode, 400);
    assert.equal((await sam('add', { text: 'bad\u0007char' })).statusCode, 400);
    const item = (await alex('state')).body.items.find((i) => i.id === samItemId);
    assert.equal(item.text, 'Wool socks');
    assert.equal(item.link, 'https://example.com/socks');
    assert.equal(item.note, 'size 42');
    assert.equal(item.claimedBy, null);
  });

  await test('owner cannot claim own gift', async () => {
    assert.equal((await sam('claim', { id: samItemId })).statusCode, 400);
  });

  await test('claim is visible to claimer, hidden from owner', async () => {
    assert.equal((await alex('claim', { id: samItemId })).statusCode, 200);
    const forAlex = (await alex('state')).body.items.find((i) => i.id === samItemId);
    assert.equal(forAlex.claimedByMe, true);
    assert.equal(forAlex.claimedBy, 'Alex');
    const forSam = (await sam('state')).body.items.find((i) => i.id === samItemId);
    assert.equal(forSam.mine, true);
    assert.equal(forSam.claimedBy, null);
    assert.equal(forSam.claimedByMe, false);
  });

  await test('a third person sees who claimed it and cannot take it over', async () => {
    assert.equal((await jo('join')).statusCode, 200);
    const forJo = (await jo('state')).body.items.find((i) => i.id === samItemId);
    assert.equal(forJo.claimedBy, 'Alex');
    const res = await jo('claim', { id: samItemId });
    assert.equal(res.statusCode, 409);
    assert.match(res.body.error, /Alex is already getting this/);
  });

  await test('only the claimer can unclaim; only the owner can remove a gift', async () => {
    assert.equal((await jo('unclaim', { id: samItemId })).statusCode, 409);
    assert.equal((await alex('remove', { id: samItemId })).statusCode, 403);
    assert.equal((await alex('unclaim', { id: samItemId })).statusCode, 200);
    assert.equal((await sam('remove', { id: samItemId })).statusCode, 200);
    assert.equal((await sam('remove', { id: samItemId })).statusCode, 404);
    assert.equal((await sam('remove', { id: 'not-an-id' })).statusCode, 400);
  });

  await test('removing a person deletes their list and releases their claims', async () => {
    const samGift = (await sam('add', { text: 'Skillet' })).body.id;
    const alexGift = (await alex('add', { text: 'Headphones' })).body.id;
    assert.equal((await alex('claim', { id: samGift })).statusCode, 200);
    assert.equal((await jo('claim', { id: alexGift })).statusCode, 200);

    assert.equal((await sam('remove-member', { name: 'alex' })).statusCode, 200);

    const state = (await sam('state')).body;
    assert.deepEqual(state.members, ['Jo', 'Sam']);
    assert.ok(!state.items.some((i) => i.id === alexGift), 'Alex’s gifts are gone');
    const skillet = state.items.find((i) => i.id === samGift);
    assert.ok(skillet, 'Sam’s gift remains');
    assert.equal((await jo('state')).body.items.find((i) => i.id === samGift).claimedBy, null); // claim released

    assert.equal((await alex('state')).statusCode, 403);
    assert.equal((await alex('add', { text: 'x' })).statusCode, 403);
    assert.equal((await sam('remove-member', { name: 'Alex' })).statusCode, 404);
  });

  await test('a removed person can rejoin by adding their name again, with a fresh empty list', async () => {
    assert.equal((await alex('join')).statusCode, 200);
    const state = (await alex('state')).body;
    assert.deepEqual(state.members, ['Alex', 'Jo', 'Sam']);
    assert.equal(state.items.filter((i) => i.owner === 'Alex').length, 0);
    assert.equal((await sam('remove-member', { name: 'Alex' })).statusCode, 200);
  });

  await test('the session is capped at six people, whether added or joining', async () => {
    for (const n of ['A', 'B']) assert.equal((await sam('add-member', { name: n })).statusCode, 200); // Sam, Jo + 2
    for (const n of ['C', 'D']) assert.equal((await as(n)('join')).statusCode, 200);                    // + 2 = 6
    const added = await sam('add-member', { name: 'Overflow' });
    assert.equal(added.statusCode, 409);
    assert.match(added.body.error, /full/);
    const joined = await as('Overflow')('join');
    assert.equal(joined.statusCode, 403);
    assert.match(joined.body.error, /full/);
    assert.equal((await as('c')('join')).statusCode, 200); // existing people can still get back in
  });

  await test('sessions are isolated from each other', async () => {
    assert.equal((await call({ room: 'xmas-otherroom', me: 'Sam', action: 'state' })).statusCode, 403);
    assert.deepEqual(await names('xmas-otherroom'), []);
  });

  await test('leaving as the last person empties the session', async () => {
    const room = 'xmas-solo-room';
    const solo = as('Pat', room);
    assert.equal((await solo('join')).statusCode, 200);
    await solo('add', { text: 'Gift' });
    const res = await solo('remove-member', { name: 'Pat' });
    assert.equal(res.body.removedSelf, true);
    assert.deepEqual(await names(room), []);
    assert.equal((await solo('state')).statusCode, 403);
  });

  await test('deleting a session wipes it for everyone', async () => {
    assert.equal((await jo('delete-room')).statusCode, 200);
    assert.deepEqual(await names(), []);
    assert.equal((await sam('state')).statusCode, 403);
    assert.equal((await jo('delete-room')).statusCode, 403);
  });

  await test('unknown action and malformed body are rejected', async () => {
    assert.equal((await sam('explode')).statusCode, 400);
    assert.equal((await call('not json')).statusCode, 400);
  });

  console.log(`\n${passed} tests passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
