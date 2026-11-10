/* Gift lists front end.
   All user-supplied text is written with textContent, never innerHTML. */
(() => {
  'use strict';

  const POLL_MS = 5000;
  const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // 31 characters, no look-alikes
  const ROOM_RE = /^[a-z0-9-]{8,40}$/;
  const STORE_SESSIONS = 'gifts.sessions'; // [{ room, me, label }], newest first
  const STORE_LAST = 'gifts.last';         // room code to reopen on the next visit
  const MAX_SESSIONS = 20;

  const $ = (id) => document.getElementById(id);
  const state = { room: '', me: '', label: '', data: null, tab: null, timer: null, refreshing: false, namesTicket: 0 };

  const store = {
    get(key) { try { return localStorage.getItem(key); } catch (_) { return null; } },
    set(key, value) { try { localStorage.setItem(key, value); } catch (_) { /* storage can be unavailable */ } },
    del(key) { try { localStorage.removeItem(key); } catch (_) { /* ignore */ } },
  };

  /* ---------- helpers ---------- */

  function newCode() {
    // 10 random characters; rejection sampling avoids modulo bias.
    let out = '';
    const limit = 256 - (256 % CODE_ALPHABET.length);
    while (out.length < 10) {
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      for (const b of bytes) {
        if (b < limit && out.length < 10) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
      }
    }
    return `xmas-${out}`;
  }

  function normaliseRoom(value) {
    const v = String(value || '').trim().toLowerCase();
    return ROOM_RE.test(v) ? v : '';
  }

  function setStatus(message, isError) {
    const node = $('status');
    node.textContent = message || '';
    node.classList.toggle('is-error', Boolean(isError));
  }

  async function request(body) {
    const res = await fetch('/api/room', {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch (_) { /* non-JSON error body */ }
    if (!res.ok) {
      const err = new Error((json && json.error) || 'Something went wrong. Try again.');
      err.status = res.status;
      throw err;
    }
    return json;
  }

  const post = (action, extra) => request({ room: state.room, me: state.me, action, ...(extra || {}) });

  function showScreen(name) {
    $('join').hidden = name !== 'join';
    $('app').hidden = name !== 'app';
  }

  function safeLink(href) {
    try {
      const url = new URL(href);
      return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
    } catch (_) {
      return null;
    }
  }

  function plural(n, word) { return `${n} ${word}${n === 1 ? '' : 's'}`; }

  /* ---------- saved sessions (this device only) ---------- */

  const defaultLabel = (room) => `Session ${room.slice(-4)}`;

  function loadSessions() {
    try {
      const list = JSON.parse(store.get(STORE_SESSIONS) || '[]');
      if (!Array.isArray(list)) return [];
      return list
        .filter((s) => s && typeof s.me === 'string' && normaliseRoom(s.room))
        .map((s) => ({ room: s.room, me: s.me, label: String(s.label || defaultLabel(s.room)).slice(0, 40) }))
        .slice(0, MAX_SESSIONS);
    } catch (_) {
      return [];
    }
  }

  function saveSessions(list) { store.set(STORE_SESSIONS, JSON.stringify(list.slice(0, MAX_SESSIONS))); }

  function upsertSession(room, me, label) {
    const all = loadSessions();
    const previous = all.find((s) => s.room === room);
    const entry = { room, me, label: label || (previous && previous.label) || defaultLabel(room) };
    saveSessions([entry, ...all.filter((s) => s.room !== room)]);
    return entry;
  }

  function forgetSession(room) {
    saveSessions(loadSessions().filter((s) => s.room !== room));
    if (store.get(STORE_LAST) === room) store.del(STORE_LAST);
  }

  function renderSessions() {
    const sessions = loadSessions();
    $('sessions-box').hidden = sessions.length === 0;
    $('sessions').replaceChildren(...sessions.map((s) => {
      const li = document.createElement('li');
      li.className = 'row';

      const main = document.createElement('div');
      main.className = 'row-main';
      const title = document.createElement('strong');
      title.textContent = s.label;
      const sub = document.createElement('span');
      sub.className = 'row-sub';
      sub.textContent = `as ${s.me}`;
      main.append(title, sub);

      const actions = document.createElement('div');
      actions.className = 'row-actions';
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'btn btn-primary btn-small';
      open.textContent = 'Open';
      open.setAttribute('aria-label', `Open ${s.label} as ${s.me}`);
      open.addEventListener('click', () => {
        $('join-error').textContent = '';
        enter(s.room, s.me, s.label).catch((err) => {
          if (err.status === 403) { forgetSession(s.room); renderSessions(); }
          $('join-error').textContent = err.message;
        });
      });
      const forget = document.createElement('button');
      forget.type = 'button';
      forget.className = 'btn btn-quiet btn-small';
      forget.textContent = 'Forget';
      forget.setAttribute('aria-label', `Forget ${s.label} on this device`);
      forget.addEventListener('click', () => { forgetSession(s.room); renderSessions(); });
      actions.append(open, forget);

      li.append(main, actions);
      return li;
    }));
  }

  /* ---------- entering and leaving ---------- */

  async function enter(room, me, label) {
    state.room = room;
    state.me = me;
    try {
      const joined = await request({ room, me, action: 'join' }); // 403 if the name isn't on the list
      state.me = joined.me;
    } catch (err) {
      state.room = '';
      state.me = '';
      throw err;
    }
    const entry = upsertSession(room, state.me, String(label || '').trim().slice(0, 40));
    store.set(STORE_LAST, room);
    state.label = entry.label;
    state.tab = state.me;
    state.data = null;
    $('session-label').textContent = state.label;
    $('who').textContent = `as ${state.me}`;
    setPeopleOpen(false);
    showScreen('app');
    setStatus('');
    await refresh();
    startPolling();
  }

  // Back to the start screen. Pass forgetRoom to also drop that session from this device.
  function goHome(message, forgetRoom) {
    stopPolling();
    if (forgetRoom) forgetSession(forgetRoom);
    store.del(STORE_LAST);
    state.room = '';
    state.data = null;
    renderSessions();
    $('room').value = '';
    $('name').value = '';
    $('label').value = '';
    clearNames();
    $('join-error').textContent = message || '';
    setStatus('');
    showScreen('join');
  }

  /* ---------- polling ---------- */

  function startPolling() {
    stopPolling();
    state.timer = setInterval(() => { if (!document.hidden) refresh(); }, POLL_MS);
  }

  function stopPolling() {
    if (state.timer) clearInterval(state.timer);
    state.timer = null;
  }

  async function refresh() {
    if (state.refreshing || !state.room) return;
    state.refreshing = true;
    const room = state.room;
    try {
      const data = await post('state');
      if (room !== state.room) return; // user switched session mid-request
      state.data = data;
      state.me = data.me;
      render();
      if (!$('status').classList.contains('is-error')) setStatus('');
    } catch (err) {
      if (err.status === 403) {
        goHome('You’ve been removed from this session, or it has expired. To rejoin, enter the room code and pick or add your name.', room);
      } else {
        setStatus(err.status ? err.message : 'Can’t reach the server. Retrying…', true);
      }
    } finally {
      state.refreshing = false;
    }
  }

  /* ---------- rendering ---------- */

  function render() {
    const { members, items } = state.data;
    const ordered = [state.me, ...members.filter((m) => m !== state.me)];
    if (!ordered.includes(state.tab)) state.tab = state.me;

    $('waiting').hidden = members.length > 1;
    renderPeople(ordered);
    renderTabs(ordered);
    renderTag(state.tab, items);
    renderItems(state.tab, items);
    $('add-form').hidden = state.tab !== state.me;
  }

  function renderPeople(ordered) {
    $('people-list').replaceChildren(...ordered.map((name) => {
      const self = name === state.me;
      const li = document.createElement('li');
      li.className = 'row';

      const main = document.createElement('div');
      main.className = 'row-main';
      main.textContent = self ? `${name} (you)` : name;

      const actions = document.createElement('div');
      actions.className = 'row-actions';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-quiet btn-small';
      btn.textContent = self ? 'Leave' : 'Remove';
      btn.setAttribute('aria-label', self ? 'Leave this session' : `Remove ${name}`);
      btn.addEventListener('click', () => removePerson(name));
      actions.append(btn);

      li.append(main, actions);
      return li;
    }));
  }

  function renderTabs(ordered) {
    $('tabs').replaceChildren(...ordered.map((name) => {
      const mine = name === state.me;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tab';
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-selected', String(name === state.tab));
      btn.textContent = mine ? 'My list' : `${name}’s list`;
      btn.addEventListener('click', () => {
        if (state.tab === name) return;
        state.tab = name;
        render();
        swingTag();
      });
      return btn;
    }));
  }

  function swingTag() {
    const tag = $('tag');
    tag.classList.remove('swing');
    void tag.offsetWidth; // restart the animation
    tag.classList.add('swing');
  }

  function renderTag(owner, items) {
    const mine = owner === state.me;
    const list = items.filter((i) => i.owner === owner);
    $('tag-title').textContent = mine ? 'My list' : `${owner}’s list`;
    let sub;
    if (list.length === 0) sub = 'Nothing here yet';
    else if (mine) sub = plural(list.length, 'gift');
    else {
      const open = list.filter((i) => !i.claimedBy && !i.claimedByMe).length;
      sub = `${open} of ${plural(list.length, 'gift')} still unclaimed`;
    }
    $('tag-sub').textContent = sub;
  }

  function renderItems(owner, items) {
    const mine = owner === state.me;
    const list = items.filter((i) => i.owner === owner);
    $('items').replaceChildren(...list.map((item) => buildItem(item, mine)));
    const empty = $('empty');
    empty.hidden = list.length > 0;
    empty.textContent = mine
      ? 'Your list is empty. Add the first gift above.'
      : `${owner} hasn’t added anything yet.`;
  }

  function actionButton(label, className, ariaLabel, handler) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `btn btn-small ${className}`;
    btn.textContent = label;
    btn.setAttribute('aria-label', ariaLabel);
    btn.addEventListener('click', () => {
      btn.disabled = true;
      handler();
    });
    return btn;
  }

  function buildItem(item, mine) {
    const li = document.createElement('li');
    li.className = 'gift';

    const main = document.createElement('div');
    const name = document.createElement('span');
    name.className = 'gift-name';
    name.textContent = item.text;
    main.append(name);

    const url = item.link ? safeLink(item.link) : null;
    if (url) {
      const a = document.createElement('a');
      a.className = 'gift-link';
      a.href = url.href;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = url.hostname.replace(/^www\./, '');
      main.append(a);
    }
    if (item.note) {
      const note = document.createElement('p');
      note.className = 'gift-note';
      note.textContent = item.note;
      main.append(note);
    }

    const actions = document.createElement('div');
    actions.className = 'gift-actions';

    if (mine) {
      actions.append(actionButton('Remove', 'btn-quiet', `Remove ${item.text}`, () => act('remove', item.id)));
    } else if (item.claimedByMe) {
      li.classList.add('is-mine-claimed');
      const label = document.createElement('span');
      label.className = 'claim-state';
      label.textContent = '✓ You’re getting this';
      actions.append(label, actionButton('Undo', 'btn-quiet', `Undo claim on ${item.text}`, () => act('unclaim', item.id)));
    } else if (item.claimedBy) {
      const label = document.createElement('span');
      label.className = 'claim-state';
      label.textContent = `${item.claimedBy} is getting this`;
      actions.append(label);
    } else {
      actions.append(actionButton('I’ll get this', 'btn-primary', `Claim ${item.text}`, () => act('claim', item.id)));
    }

    li.append(main, actions);
    return li;
  }

  async function act(action, id) {
    try {
      await post(action, { id });
      setStatus('');
    } catch (err) {
      setStatus(err.message, true);
    }
    await refresh(); // always resync, e.g. after someone else claimed first
  }

  /* ---------- people ---------- */

  function setPeopleOpen(open) {
    $('people').hidden = !open;
    $('people-toggle').setAttribute('aria-expanded', String(open));
    if (!open) $('person-error').textContent = '';
  }

  async function removePerson(name) {
    const self = name === state.me;
    const room = state.room;
    const question = self
      ? 'Leave this session? Your list and any claims you made will be deleted.'
      : `Remove ${name}? Their list and any claims they made will be deleted.`;
    if (!window.confirm(question)) return;
    try {
      await post('remove-member', { name });
      if (self) { goHome('You left the session.', room); return; }
      setStatus('');
    } catch (err) {
      setStatus(err.message, true);
    }
    await refresh();
  }

  async function deleteSession() {
    const room = state.room;
    if (!window.confirm('Delete this whole session? All lists and claims are deleted for everyone. This can’t be undone.')) return;
    try {
      await post('delete-room');
      goHome('Session deleted.', room);
    } catch (err) {
      setStatus(err.message, true);
    }
  }

  async function onPersonSubmit(event) {
    event.preventDefault();
    const error = $('person-error');
    error.textContent = '';
    const name = $('p-name').value.trim();
    if (!name) { error.textContent = 'Enter a name.'; $('p-name').focus(); return; }
    try {
      await post('add-member', { name });
      $('p-name').value = '';
      await refresh();
    } catch (err) {
      error.textContent = err.message;
    }
  }

  /* ---------- start screen ---------- */

  const HINT_DEFAULT = 'Starting something new? Generate a code. Joining? Open the invite link, or paste the code here.';
  const HINT_NEW = 'No one is in this session yet. Enter your name to start it.';
  const HINT_EXISTING = 'This session exists. Tap your name to join, or add yourself below.';
  const HINT_FAILED = 'Couldn’t look this session up, but you can still enter your name to join.';

  function clearNames() {
    state.namesTicket += 1; // ignore any lookup still in flight
    $('who-box').hidden = true;
    $('names-group').hidden = true;
    $('names').replaceChildren();
    $('room-hint').textContent = HINT_DEFAULT;
  }

  // Shows who is already in the session (tap to join as them) and a box to add yourself.
  function showWho(list, lookupFailed) {
    const hasNames = list.length > 0;
    $('who-box').hidden = false;
    $('names-group').hidden = !hasNames;
    $('names').replaceChildren(...list.map((n) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip';
      chip.textContent = n;
      chip.setAttribute('aria-label', `Join as ${n}`);
      chip.addEventListener('click', () => joinAs(n));
      return chip;
    }));
    $('name-label').textContent = hasNames ? 'Not on the list? Add yourself' : 'Your name';
    $('join-btn').textContent = hasNames ? 'Add me and join' : 'Start session';
    $('room-hint').textContent = lookupFailed ? HINT_FAILED : (hasNames ? HINT_EXISTING : HINT_NEW);
  }

  async function loadNames(room) {
    const ticket = ++state.namesTicket;
    const current = () => ticket === state.namesTicket && normaliseRoom($('room').value) === room;
    try {
      const data = await request({ room, action: 'names' });
      if (current()) showWho(Array.isArray(data.members) ? data.members : [], false);
    } catch (_) {
      if (current()) showWho([], true);
    }
  }

  let namesTimer = null;
  function onRoomInput() {
    clearTimeout(namesTimer);
    $('join-error').textContent = '';
    const room = normaliseRoom($('room').value);
    if (!room) { clearNames(); return; }
    namesTimer = setTimeout(() => loadNames(room), 350);
  }

  function setJoining(busy) {
    for (const node of $('who-box').querySelectorAll('button, input')) node.disabled = busy;
  }

  // Join as an existing person (tapped) or as a new one (typed). The server adds new names.
  function joinAs(name) {
    const error = $('join-error');
    error.textContent = '';
    const room = normaliseRoom($('room').value);
    if (!room) {
      error.textContent = 'Room code must be 8 to 40 letters, numbers or dashes. Use “Generate code” for a safe one.';
      $('room').focus();
      return;
    }
    const me = String(name || '').trim();
    if (!me) {
      error.textContent = $('names-group').hidden ? 'Enter your name.' : 'Tap your name above, or enter a new one.';
      $('name').focus();
      return;
    }
    setJoining(true);
    enter(room, me, $('label').value)
      .catch((err) => { error.textContent = err.message; })
      .finally(() => setJoining(false));
  }

  function onJoinSubmit(event) {
    event.preventDefault();
    joinAs($('name').value);
  }

  /* ---------- forms in the session ---------- */

  async function onAddSubmit(event) {
    event.preventDefault();
    const error = $('add-error');
    const btn = $('add-btn');
    error.textContent = '';
    const text = $('g-text').value.trim();
    if (!text) { error.textContent = 'Enter the gift.'; $('g-text').focus(); return; }
    btn.disabled = true;
    try {
      await post('add', { text, link: $('g-link').value, note: $('g-note').value });
      $('g-text').value = '';
      $('g-link').value = '';
      $('g-note').value = '';
      $('g-text').focus();
      await refresh();
    } catch (err) {
      error.textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  }

  async function copyInvite() {
    const link = `${location.origin}${location.pathname}?room=${encodeURIComponent(state.room)}`;
    try {
      await navigator.clipboard.writeText(link);
      setStatus('Invite link copied. Send it to them: they can pick their name or add it when they open it.');
    } catch (_) {
      setStatus(`Couldn’t copy automatically. Share this room code instead: ${state.room}`, true);
    }
  }

  /* ---------- start ---------- */

  function autoEnter(session) {
    setStatus('Opening your session…');
    enter(session.room, session.me, session.label).then(() => setStatus('')).catch((err) => {
      if (err.status === 403) { forgetSession(session.room); renderSessions(); }
      showScreen('join');
      setStatus('');
      $('join-error').textContent = err.message;
    });
  }

  function init() {
    const params = new URLSearchParams(location.search);
    const urlRoom = normaliseRoom(params.get('room'));
    const sessions = loadSessions();

    // Keep the room code out of the address bar, history and referrers.
    if (params.has('room')) history.replaceState(null, '', location.pathname);

    $('room').addEventListener('input', onRoomInput);
    $('name').addEventListener('input', () => { $('join-error').textContent = ''; });
    $('join-form').addEventListener('submit', onJoinSubmit);
    $('add-form').addEventListener('submit', onAddSubmit);
    $('person-form').addEventListener('submit', onPersonSubmit);
    $('gen').addEventListener('click', () => { $('room').value = newCode(); onRoomInput(); });
    $('invite').addEventListener('click', copyInvite);
    $('leave').addEventListener('click', () => goHome(''));
    $('people-toggle').addEventListener('click', () => setPeopleOpen($('people').hidden));
    $('delete-room').addEventListener('click', deleteSession);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });

    $('room-hint').textContent = HINT_DEFAULT;
    renderSessions();

    // An invite link for a session already saved here opens it straight away.
    const target = urlRoom
      ? sessions.find((s) => s.room === urlRoom)
      : sessions.find((s) => s.room === normaliseRoom(store.get(STORE_LAST)));
    if (target) { autoEnter(target); return; }

    showScreen('join');
    if (urlRoom) {
      $('room').value = urlRoom;
      loadNames(urlRoom).then(() => {
        const first = $('names').querySelector('button') || ($('who-box').hidden ? null : $('name'));
        if (first) first.focus();
      });
    }
  }

  init();
})();
