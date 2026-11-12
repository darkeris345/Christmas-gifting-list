'use strict';

// One endpoint, POST /api/room, with an "action" field:
//   names        list the people in a session (needs only the room code)
//   join         join as an existing person, or add yourself as a new one
//   state        read everything the caller is allowed to see
//   add-member   add a person to the session (e.g. before they arrive)
//   remove-member remove a person (deletes their list and any claims they made)
//   delete-room  delete the whole session
//   rename-member change your own name (your list and claims move with you)
//   add, edit, remove, claim, unclaim   gift actions
//
// Data model (Redis hashes, one pair per room):
//   xmas:<room>:members   memberKey (lowercase name) -> display name
//   xmas:<room>:items     itemId -> JSON { id, owner, text, link, note, claimedBy, claimedAt, editedAt, createdAt }
//
// Access: the room code is the shared secret. Anyone with it can join by picking
// an existing name or adding a new one (up to MAX_MEMBERS). Identity is
// honour-based (no passwords), but the server hides claim details from the list
// owner so nobody spoils a surprise by accident.

const crypto = require('node:crypto');
const { pipeline, toObject, RedisError } = require('../lib/redis');

const MAX_MEMBERS = 6; // built for two; raise if more people join in
const MAX_ITEMS_TOTAL = 300;
const TTL_SECONDS = 60 * 60 * 24 * 60; // data expires 60 days after the last write
const ROOM_RE = /^[a-z0-9-]{8,40}$/;
const ID_RE = /^[0-9a-f-]{36}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function parseBody(body) {
  if (body && typeof body === 'object') return body;
  if (typeof body === 'string') {
    try {
      const parsed = JSON.parse(body);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch (_) { /* fall through */ }
  }
  throw new HttpError(400, 'Invalid request.');
}

function cleanString(value, { label, min = 0, max }) {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string') throw new HttpError(400, `${label} must be text.`);
  const v = value.replace(/\s+/g, ' ').trim();
  if (CONTROL_RE.test(v)) throw new HttpError(400, `${label} contains characters that aren’t allowed.`);
  if (v.length < min) throw new HttpError(400, `${label} is required.`);
  if (v.length > max) throw new HttpError(400, `${label} must be ${max} characters or fewer.`);
  return v;
}

// Accepts "example.com/thing" or a full URL. Only http(s) is allowed, which
// blocks javascript:, data: and similar schemes.
function cleanLink(value) {
  const raw = cleanString(value, { label: 'Link', max: 500 });
  if (!raw) return '';
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch (_) {
    throw new HttpError(400, 'That link doesn’t look right. Use a full web address.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new HttpError(400, 'Links must start with http:// or https://.');
  }
  return url.href;
}

// Validates one gift. Throws HttpError with a message that makes sense to show a person.
function cleanGift(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new HttpError(400, 'That gift isn’t valid.');
  return {
    text: cleanString(raw.text, { label: 'Gift', min: 1, max: 120 }),
    note: cleanString(raw.note, { label: 'Note', max: 200 }),
    link: cleanLink(raw.link),
  };
}

function parseItem(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch (_) { return null; }
  }
  return null;
}

function requireItemId(value) {
  if (typeof value !== 'string' || !ID_RE.test(value)) throw new HttpError(400, 'Unknown gift.');
  return value;
}

const byName = (a, b) => a.localeCompare(b);

// Database trouble gets a plain explanation for the person setting the site up.
// Nothing sensitive is in these messages.
const DATABASE_MESSAGES = {
  'not-configured': 'The server isn’t connected to its database yet. Whoever set up this site needs to connect Redis (README, step 3) and redeploy.',
  rejected: 'The server’s database refused the connection. Whoever set up this site should check the Redis token.',
  unreachable: 'The server can’t reach its database right now. Try again in a minute.',
};

async function loadMembership(keys, meKey) {
  const display = (await pipeline([['HGET', keys.members, meKey]]))[0];
  if (!display) throw new HttpError(403, 'Join this session first.');
  return display;
}

async function loadItem(keys, id) {
  const item = parseItem((await pipeline([['HGET', keys.items, id]]))[0]);
  if (!item) throw new HttpError(404, 'That gift has been removed.');
  return item;
}

async function saveItem(keys, item) {
  await pipeline([
    ['HSET', keys.items, item.id, JSON.stringify(item)],
    ['EXPIRE', keys.items, TTL_SECONDS],
    ['EXPIRE', keys.members, TTL_SECONDS],
  ]);
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      throw new HttpError(405, 'Method not allowed.');
    }

    const body = parseBody(req.body);

    const room = typeof body.room === 'string' ? body.room.trim().toLowerCase() : '';
    if (!ROOM_RE.test(room)) {
      throw new HttpError(400, 'Room code must be 8 to 40 letters, numbers or dashes.');
    }
    const keys = { members: `xmas:${room}:members`, items: `xmas:${room}:items` };

    // Lets the join screen show "tap your name". Anyone holding the code could
    // already join as a listed name, so this reveals nothing new.
    if (body.action === 'names') {
      const members = toObject((await pipeline([['HGETALL', keys.members]]))[0]);
      return res.status(200).json({ members: Object.values(members).sort(byName) });
    }

    const meName = cleanString(body.me, { label: 'Name', min: 1, max: 30 });
    const meKey = meName.toLowerCase();

    switch (body.action) {
      case 'join': {
        const [existing, count] = await pipeline([
          ['HGET', keys.members, meKey],
          ['HLEN', keys.members],
        ]);
        if (existing) return res.status(200).json({ me: existing });
        if (count >= MAX_MEMBERS) {
          throw new HttpError(403, 'This session is full. Ask someone in it to remove a person first.');
        }
        // A new name: add the person (the first one creates the session).
        await pipeline([
          ['HSET', keys.members, meKey, meName],
          ['EXPIRE', keys.members, TTL_SECONDS],
        ]);
        return res.status(200).json({ me: meName });
      }

      case 'state': {
        const [membersRaw, itemsRaw] = await pipeline([
          ['HGETALL', keys.members],
          ['HGETALL', keys.items],
        ]);
        const members = toObject(membersRaw);
        if (!members[meKey]) throw new HttpError(403, 'Join this session first.');

        const items = Object.values(toObject(itemsRaw))
          .map(parseItem)
          .filter(Boolean)
          .sort((a, b) => a.createdAt - b.createdAt)
          .map((it) => {
            const mine = it.owner === meKey;
            return {
              id: it.id,
              owner: members[it.owner] || it.owner,
              text: it.text,
              link: it.link || '',
              note: it.note || '',
              mine,
              // The list owner never learns who has claimed what.
              claimedBy: mine || !it.claimedBy ? null : (members[it.claimedBy] || null),
              claimedByMe: !mine && it.claimedBy === meKey,
              // Only the person who claimed it hears that it changed afterwards.
              changedSinceClaim: !mine && it.claimedBy === meKey && Boolean(it.editedAt) && it.editedAt > (it.claimedAt || 0),
            };
          });

        return res.status(200).json({
          me: members[meKey],
          members: Object.values(members).sort(byName),
          items,
        });
      }

      case 'add-member': {
        await loadMembership(keys, meKey);
        const name = cleanString(body.name, { label: 'Name', min: 1, max: 30 });
        const key = name.toLowerCase();
        const [existing, count] = await pipeline([
          ['HGET', keys.members, key],
          ['HLEN', keys.members],
        ]);
        if (existing) throw new HttpError(409, `${existing} is already in this session.`);
        if (count >= MAX_MEMBERS) throw new HttpError(409, 'This session is full.');
        await pipeline([
          ['HSET', keys.members, key, name],
          ['EXPIRE', keys.members, TTL_SECONDS],
        ]);
        return res.status(200).json({ ok: true, name });
      }

      case 'remove-member': {
        await loadMembership(keys, meKey);
        const targetName = cleanString(body.name, { label: 'Name', min: 1, max: 30 });
        const targetKey = targetName.toLowerCase();
        const [membersRaw, itemsRaw] = await pipeline([
          ['HGETALL', keys.members],
          ['HGETALL', keys.items],
        ]);
        const members = toObject(membersRaw);
        if (!members[targetKey]) throw new HttpError(404, `${targetName} isn’t in this session.`);

        // Delete their gifts and release anything they had claimed from others.
        const commands = [];
        for (const raw of Object.values(toObject(itemsRaw))) {
          const it = parseItem(raw);
          if (!it) continue;
          if (it.owner === targetKey) {
            commands.push(['HDEL', keys.items, it.id]);
          } else if (it.claimedBy === targetKey) {
            it.claimedBy = null;
            commands.push(['HSET', keys.items, it.id, JSON.stringify(it)]);
          }
        }
        commands.push(['HDEL', keys.members, targetKey]);
        if (Object.keys(members).length === 1) {
          commands.push(['DEL', keys.items], ['DEL', keys.members]); // last person out
        }
        await pipeline(commands);
        return res.status(200).json({ ok: true, removedSelf: targetKey === meKey });
      }

      case 'delete-room': {
        await loadMembership(keys, meKey);
        await pipeline([['DEL', keys.items], ['DEL', keys.members]]);
        return res.status(200).json({ ok: true });
      }

      case 'add': {
        await loadMembership(keys, meKey);
        const { text, note, link } = cleanGift({ text: body.text, note: body.note, link: body.link });

        const total = (await pipeline([['HLEN', keys.items]]))[0];
        if (total >= MAX_ITEMS_TOTAL) throw new HttpError(409, 'This session has reached its gift limit.');

        const item = {
          id: crypto.randomUUID(),
          owner: meKey,
          text,
          link,
          note,
          claimedBy: null,
          createdAt: Date.now(),
        };
        await saveItem(keys, item);
        return res.status(200).json({ ok: true, id: item.id });
      }

      case 'edit': {
        await loadMembership(keys, meKey);
        const item = await loadItem(keys, requireItemId(body.id));
        if (item.owner !== meKey) throw new HttpError(403, 'You can only edit gifts on your own list.');
        const gift = cleanGift({ text: body.text, note: body.note, link: body.link });
        const changed = gift.text !== item.text || gift.link !== (item.link || '') || gift.note !== (item.note || '');
        if (changed) {
          Object.assign(item, gift);
          item.editedAt = Date.now();
          await saveItem(keys, item); // any claim stays; the claimer is told it changed
        }
        return res.status(200).json({ ok: true, changed });
      }

      case 'rename-member': {
        await loadMembership(keys, meKey);
        const newName = cleanString(body.name, { label: 'Name', min: 1, max: 30 });
        const newKey = newName.toLowerCase();
        const [membersRaw, itemsRaw] = await pipeline([
          ['HGETALL', keys.members],
          ['HGETALL', keys.items],
        ]);
        const members = toObject(membersRaw);
        if (newKey !== meKey && members[newKey]) throw new HttpError(409, `${members[newKey]} is already in this session.`);

        const commands = [];
        if (newKey !== meKey) {
          // Your gifts and the gifts you claimed move to the new name.
          for (const raw of Object.values(toObject(itemsRaw))) {
            const it = parseItem(raw);
            if (!it) continue;
            let moved = false;
            if (it.owner === meKey) { it.owner = newKey; moved = true; }
            if (it.claimedBy === meKey) { it.claimedBy = newKey; moved = true; }
            if (moved) commands.push(['HSET', keys.items, it.id, JSON.stringify(it)]);
          }
          commands.push(['HDEL', keys.members, meKey]);
        }
        commands.push(['HSET', keys.members, newKey, newName], ['EXPIRE', keys.members, TTL_SECONDS]);
        await pipeline(commands);
        return res.status(200).json({ ok: true, me: newName });
      }

      case 'remove': {
        await loadMembership(keys, meKey);
        const item = await loadItem(keys, requireItemId(body.id));
        if (item.owner !== meKey) throw new HttpError(403, 'You can only remove gifts from your own list.');
        await pipeline([['HDEL', keys.items, item.id]]);
        return res.status(200).json({ ok: true });
      }

      case 'claim': {
        const display = await loadMembership(keys, meKey);
        const item = await loadItem(keys, requireItemId(body.id));
        if (item.owner === meKey) throw new HttpError(400, 'You can’t claim gifts from your own list.');
        if (item.claimedBy && item.claimedBy !== meKey) {
          const other = (await pipeline([['HGET', keys.members, item.claimedBy]]))[0] || 'Someone';
          throw new HttpError(409, `${other} is already getting this.`);
        }
        item.claimedBy = meKey;
        item.claimedAt = Date.now(); // claiming again is how someone says "got it" after a change
        await saveItem(keys, item);
        return res.status(200).json({ ok: true, me: display });
      }

      case 'unclaim': {
        await loadMembership(keys, meKey);
        const item = await loadItem(keys, requireItemId(body.id));
        if (item.claimedBy !== meKey) throw new HttpError(409, 'You haven’t claimed this gift.');
        item.claimedBy = null;
        item.claimedAt = null;
        await saveItem(keys, item);
        return res.status(200).json({ ok: true });
      }

      default:
        throw new HttpError(400, 'Unknown action.');
    }
  } catch (err) {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err instanceof RedisError && DATABASE_MESSAGES[err.kind]) {
      console.error(`room api: database problem (${err.kind}): ${err.message}`);
      return res.status(503).json({ error: DATABASE_MESSAGES[err.kind] });
    }
    // Log the cause server-side only; never return internals to the client.
    console.error('room api error:', err && err.message);
    return res.status(500).json({ error: 'Something went wrong on the server. Try again.' });
  }
};
