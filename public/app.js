/* Gift lists front end.
   All user-supplied text is written with textContent, never innerHTML. */
(() => {
  'use strict';

  const POLL_MS = 5000;
  const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // 31 characters, no look-alikes
  const ROOM_RE = /^[a-z0-9-]{8,40}$/;
  const STORE_SESSIONS = 'gifts.sessions'; // [{ room, me, label }], stable order
  const STORE_LAST = 'gifts.last';         // room code to reopen on the next visit
  const MAX_SESSIONS = 20;
  const SWIPE_MIN = 70; // px

  const $ = (id) => document.getElementById(id);
  const state = {
    room: '', me: '', label: '', data: null, tab: null, timer: null,
    refreshingRoom: '', namesTicket: 0, previous: null, revealTab: false, focusTab: false, revealSession: false, editingId: '',
  };

  const store = {
    get(key) { try { return localStorage.getItem(key); } catch (_) { return null; } },
    set(key, value) { try { localStorage.setItem(key, value); } catch (_) { /* storage can be unavailable */ } },
    del(key) { try { localStorage.removeItem(key); } catch (_) { /* ignore */ } },
  };

  /* ---------- helpers ---------- */

  function newCode() {
    // 10 random characters (about 50 bits); rejection sampling avoids modulo bias.
    let out = '';
    const limit = 256 - (256 % CODE_ALPHABET.length);
    while (out.length < 10) {
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      for (const b of bytes) {
        if (b < limit && out.length < 10) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
      }
    }
    return `xmas-${out.slice(0, 5)}-${out.slice(5)}`; // grouped so it is easy to read out or type
  }

  function normaliseRoom(value) {
    const v = String(value || '').trim().toLowerCase();
    return ROOM_RE.test(v) ? v : '';
  }

  // Accepts a bare room code, or a pasted invite link (even with other words around it).
  function extractRoom(value) {
    const raw = String(value || '');
    const fromLink = raw.match(/[?&]room=([a-zA-Z0-9-]{8,40})/);
    return normaliseRoom(fromLink ? fromLink[1] : raw);
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

  async function copyText(text, okMessage) {
    try {
      await navigator.clipboard.writeText(text);
      setStatus(okMessage);
    } catch (_) {
      setStatus(`Couldn’t copy automatically. The code is: ${text}`, true);
    }
  }

  function cleanName(value) {
    return String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 30);
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
        .slice(-MAX_SESSIONS);
    } catch (_) {
      return [];
    }
  }

  function saveSessions(list) { store.set(STORE_SESSIONS, JSON.stringify(list.slice(-MAX_SESSIONS))); }

  // Keeps each session in the same place, so the tabs don't shuffle when you switch.
  function upsertSession(room, me, label) {
    const all = loadSessions();
    const index = all.findIndex((s) => s.room === room);
    const previous = index >= 0 ? all[index] : null;
    const entry = { room, me, label: label || (previous && previous.label) || defaultLabel(room) };
    if (index >= 0) all[index] = entry; else all.push(entry);
    saveSessions(all);
    return entry;
  }

  function forgetSession(room) {
    saveSessions(loadSessions().filter((s) => s.room !== room));
    if (store.get(STORE_LAST) === room) store.del(STORE_LAST);
  }

  function lastUsedName() {
    const sessions = loadSessions();
    const last = sessions.find((s) => s.room === store.get(STORE_LAST)) || sessions[sessions.length - 1];
    return last ? last.me : '';
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
      const code = document.createElement('span');
      code.className = 'row-sub row-code';
      code.textContent = s.room;
      main.append(title, sub, code);

      const actions = document.createElement('div');
      actions.className = 'row-actions';
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'btn btn-primary btn-small';
      open.textContent = 'Open';
      open.setAttribute('aria-label', `Open ${s.label} as ${s.me}`);
      open.addEventListener('click', () => {
        $('join-error').textContent = '';
        $('start-error').textContent = '';
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
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'btn btn-quiet btn-small';
      copy.textContent = 'Copy code';
      copy.setAttribute('aria-label', `Copy room code for ${s.label}`);
      copy.addEventListener('click', () => copyText(s.room, 'Room code copied.'));
      actions.append(open, copy, forget);

      li.append(main, actions);
      return li;
    }));
  }

  // The strip across the top of a session: jump straight to another session, or add one.
  function renderSessionTabs() {
    const nav = $('session-tabs');
    const scrollLeft = nav.scrollLeft;
    const pills = loadSessions().map((s) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'stab';
      btn.textContent = s.label;
      btn.title = `${s.label} (${s.room})`;
      if (s.room === state.room) btn.setAttribute('aria-current', 'true');
      else btn.addEventListener('click', () => switchSession(s));
      return btn;
    });
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'stab stab-add';
    add.textContent = '+ New or join';
    add.addEventListener('click', () => goHome(''));
    nav.replaceChildren(...pills, add);
    nav.scrollLeft = scrollLeft;
    if (state.revealSession) {
      state.revealSession = false;
      const current = nav.querySelector('[aria-current]');
      if (current) current.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    }
  }

  /* ---------- entering, switching and leaving ---------- */

  function clearSessionView() {
    $('tabs').replaceChildren();
    $('items').replaceChildren();
    $('people-list').replaceChildren();
    $('tag-title').textContent = '';
    $('tag-sub').textContent = '';
    $('empty').hidden = true;
    $('add-form').hidden = true;
    $('waiting').hidden = true;
  }

  // Joins (or rejoins) a session as `me`. Nothing changes on screen unless this succeeds.
  async function enter(room, me, label) {
    const joined = await request({ room, me, action: 'join' });
    stopPolling();
    state.room = room;
    state.me = joined.me;
    const entry = upsertSession(room, state.me, String(label || '').trim().slice(0, 40));
    store.set(STORE_LAST, room);
    state.label = entry.label;
    state.tab = state.me;
    state.data = null;
    state.previous = null;
    endEdit();
    clearSessionView();
    $('session-label').textContent = state.label;
    $('who').textContent = `as ${state.me}`;
    $('room-code').textContent = room;
    $('bar-code').textContent = room;
    $('label-input').value = state.label;
    $('myname-input').value = state.me;
    closePeople();
    closeInvite();
    $('invite-for').value = '';
    state.revealSession = true;
    renderSessionTabs();
    showScreen('app');
    setStatus('');
    await refresh();
    startPolling();
  }

  async function switchSession(session) {
    setStatus(`Opening ${session.label}…`);
    try {
      await enter(session.room, session.me, session.label);
      setStatus('');
    } catch (err) {
      if (err.status === 403) forgetSession(session.room);
      renderSessionTabs();
      setStatus(err.message, true);
    }
  }

  async function switchPerson(name) {
    try {
      await enter(state.room, name, state.label);
      setStatus(`Now using this device as ${state.me}.`);
    } catch (err) {
      setStatus(err.message, true);
    }
  }

  // Back to the start screen. Pass forgetRoom to also drop that session from this device.
  function goHome(message, forgetRoom) {
    stopPolling();
    if (forgetRoom) forgetSession(forgetRoom);
    state.previous = state.room && !forgetRoom ? { room: state.room, me: state.me, label: state.label } : null;
    store.del(STORE_LAST);
    state.room = '';
    state.data = null;
    renderSessions();
    renderBack();
    $('s-name').value = lastUsedName();
    $('room').value = '';
    $('name').value = '';
    clearNames();
    $('invited').hidden = true;
    $('start-box').hidden = false;
    $('start-wrap').hidden = true;
    $('start-error').textContent = '';
    $('join-error').textContent = message || '';
    setStatus('');
    showScreen('join');
  }

  function renderBack() {
    const prev = state.previous;
    $('back-btn').hidden = !prev;
    if (prev) $('back-btn').textContent = `← Back to ${prev.label}`;
  }

  function goBack() {
    const prev = state.previous;
    if (!prev) return;
    enter(prev.room, prev.me, prev.label).catch((err) => {
      if (err.status === 403) { forgetSession(prev.room); state.previous = null; renderBack(); renderSessions(); }
      $('join-error').textContent = err.message;
    });
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
    const room = state.room;
    if (!room || state.refreshingRoom === room) return;
    state.refreshingRoom = room;
    const meAtStart = state.me;
    try {
      const data = await post('state');
      if (room !== state.room) return; // user switched session mid-request
      state.data = data;
      state.me = data.me;
      maybeAutoLabel();
      render();
      if (!$('status').classList.contains('is-error')) setStatus('');
    } catch (err) {
      if (room !== state.room) return;
      if (err.status === 403 && state.me !== meAtStart) return; // the name changed while this was in flight
      if (err.status === 403) {
        goHome('You’ve been removed from this session, or it has expired. To rejoin, use the room code and tap or add your name.', room);
      } else {
        setStatus(err.status ? err.message : 'Can’t reach the server. Retrying…', true);
      }
    } finally {
      if (state.refreshingRoom === room) state.refreshingRoom = '';
    }
  }

  // A session you never named gets "Christmas with <others>" once someone else is in it.
  function maybeAutoLabel() {
    const saved = loadSessions().find((s) => s.room === state.room);
    if (!saved || saved.label !== defaultLabel(state.room)) return;
    const others = state.data.members.filter((m) => m !== state.me);
    if (others.length === 0) return;
    const label = `Christmas with ${others.slice(0, 2).join(' & ')}${others.length > 2 ? ' +' : ''}`.slice(0, 40);
    applyLabel(label);
  }

  function applyLabel(label) {
    const entry = upsertSession(state.room, state.me, label);
    state.label = entry.label;
    $('session-label').textContent = state.label;
    $('label-input').value = state.label;
    renderSessionTabs();
  }

  /* ---------- rendering ---------- */

  const orderedPeople = () => (state.data ? [state.me, ...state.data.members.filter((m) => m !== state.me)] : []);

  function render() {
    const { items } = state.data;
    const ordered = orderedPeople();
    if (!ordered.includes(state.tab)) state.tab = state.me;

    $('waiting').hidden = ordered.length > 1;
    renderPeople(ordered);
    renderInviteNames(ordered);
    renderTabs(ordered);
    renderTag(state.tab, items);
    renderItems(state.tab, items);
    $('add-form').hidden = state.tab !== state.me;
    if (state.editingId && !items.some((i) => i.id === state.editingId && i.mine)) {
      endEdit();
      $('add-error').textContent = 'That gift was removed, so editing stopped.';
    }
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
      if (!self) {
        const sw = document.createElement('button');
        sw.type = 'button';
        sw.className = 'btn btn-quiet btn-small';
        sw.textContent = 'Switch to';
        sw.setAttribute('aria-label', `Switch to ${name}`);
        sw.addEventListener('click', () => switchPerson(name));
        actions.append(sw);
      }
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'btn btn-quiet btn-small';
      rm.textContent = self ? 'Leave' : 'Remove';
      rm.setAttribute('aria-label', self ? 'Leave this session' : `Remove ${name}`);
      rm.addEventListener('click', () => removePerson(name));
      actions.append(rm);

      li.append(main, actions);
      return li;
    }));
  }

  function renderTabs(ordered) {
    const strip = $('tabs');
    const scrollLeft = strip.scrollLeft;
    strip.replaceChildren(...ordered.map((name) => {
      const selected = name === state.tab;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tab';
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-selected', String(selected));
      btn.setAttribute('aria-controls', 'panel');
      btn.tabIndex = selected ? 0 : -1;
      btn.textContent = name === state.me ? 'My list' : `${name}’s list`;
      btn.addEventListener('click', () => selectTab(name, true)); // keep focus on the tab so arrow keys keep working
      return btn;
    }));
    strip.scrollLeft = scrollLeft;
    const selectedTab = strip.querySelector('[aria-selected="true"]');
    if (selectedTab && state.revealTab) selectedTab.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    if (selectedTab && state.focusTab) selectedTab.focus({ preventScroll: true });
    state.revealTab = false;
    state.focusTab = false;
  }

  function selectTab(name, focus) {
    if (state.tab === name || !state.data) return;
    if (state.tab === state.me) endEdit(); // moving off your own list drops a half-finished edit
    state.tab = name;
    state.revealTab = true;
    state.focusTab = Boolean(focus);
    render();
    swingTag();
  }

  // Step along the people tabs: +1 is the next person, -1 the previous one.
  function moveTab(delta, focus) {
    const ordered = orderedPeople();
    const index = ordered.indexOf(state.tab);
    const next = Math.max(0, Math.min(ordered.length - 1, index + delta));
    if (next !== index) selectTab(ordered[next], focus);
  }

  function onTabKeys(event) {
    const ordered = orderedPeople();
    let target = null;
    if (event.key === 'ArrowRight') target = Math.min(ordered.length - 1, ordered.indexOf(state.tab) + 1);
    else if (event.key === 'ArrowLeft') target = Math.max(0, ordered.indexOf(state.tab) - 1);
    else if (event.key === 'Home') target = 0;
    else if (event.key === 'End') target = ordered.length - 1;
    if (target === null) return;
    event.preventDefault();
    selectTab(ordered[target], true);
  }

  // Swipe left or right on the list to move to the next or previous person.
  function setupSwipe() {
    const panel = $('panel');
    let start = null;
    panel.addEventListener('touchstart', (event) => {
      const t = event.touches[0];
      start = event.touches.length === 1 && !event.target.closest('input, textarea, button, a')
        ? { x: t.clientX, y: t.clientY }
        : null;
    }, { passive: true });
    panel.addEventListener('touchend', (event) => {
      if (!start) return;
      const t = event.changedTouches[0];
      const dx = t.clientX - start.x;
      const dy = t.clientY - start.y;
      start = null;
      if (Math.abs(dx) >= SWIPE_MIN && Math.abs(dy) < Math.abs(dx) / 2) moveTab(dx < 0 ? 1 : -1, false);
    }, { passive: true });
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
      li.classList.toggle('is-editing', item.id === state.editingId);
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'btn btn-small btn-quiet';
      edit.textContent = 'Edit';
      edit.setAttribute('aria-label', `Edit ${item.text}`);
      edit.addEventListener('click', () => startEdit(item));
      actions.append(edit, actionButton('Remove', 'btn-quiet', `Remove ${item.text}`, () => act('remove', item.id)));
    } else if (item.claimedByMe) {
      li.classList.add('is-mine-claimed');
      const label = document.createElement('span');
      label.className = 'claim-state';
      label.textContent = '✓ You’re getting this';
      actions.append(label);
      if (item.changedSinceClaim) {
        const changed = document.createElement('p');
        changed.className = 'changed-note';
        changed.textContent = 'Changed since you claimed it. Check the details.';
        main.append(changed);
        actions.append(actionButton('Got it', 'btn-quiet', `Acknowledge the change to ${item.text}`, () => act('claim', item.id)));
      }
      actions.append(actionButton('Undo', 'btn-quiet', `Undo claim on ${item.text}`, () => act('unclaim', item.id)));
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

  /* ---------- editing a gift ---------- */

  // The gift goes into the form at the top, which isn't redrawn while the list refreshes,
  // so what you type is never lost.
  function startEdit(item) {
    state.editingId = item.id;
    $('g-text').value = item.text;
    $('g-link').value = item.link || '';
    $('g-note').value = item.note || '';
    $('form-title').textContent = 'Edit gift';
    $('add-btn').textContent = 'Save changes';
    $('cancel-edit').hidden = false;
    $('add-error').textContent = '';
    renderItems(state.tab, state.data.items);
    $('add-form').scrollIntoView({ block: 'nearest' });
    $('g-text').focus();
  }

  function endEdit() {
    const wasEditing = Boolean(state.editingId);
    state.editingId = '';
    $('form-title').textContent = 'Add a gift';
    $('add-btn').textContent = 'Add gift';
    $('cancel-edit').hidden = true;
    if (wasEditing) {
      $('g-text').value = '';
      $('g-link').value = '';
      $('g-note').value = '';
    }
  }

  function cancelEdit() {
    endEdit();
    $('add-error').textContent = '';
    if (state.data) renderItems(state.tab, state.data.items);
  }

  /* ---------- people panel ---------- */

  function closePeople() {
    $('people').hidden = true;
    $('people-toggle').setAttribute('aria-expanded', 'false');
    $('person-error').textContent = '';
  }

  function closeInvite() {
    $('invite-panel').hidden = true;
    $('invite').setAttribute('aria-expanded', 'false');
  }

  function setPeopleOpen(open) {
    if (!open) { closePeople(); return; }
    closeInvite();
    $('people').hidden = false;
    $('people-toggle').setAttribute('aria-expanded', 'true');
  }

  function setInviteOpen(open) {
    if (!open) { closeInvite(); return; }
    closePeople();
    $('invite-panel').hidden = false;
    $('invite').setAttribute('aria-expanded', 'true');
    updateInvite();
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

  async function onMyNameSubmit(event) {
    event.preventDefault();
    const error = $('person-error');
    error.textContent = '';
    const name = $('myname-input').value.trim();
    if (!name) { error.textContent = 'Enter your name.'; $('myname-input').focus(); return; }
    try {
      const result = await post('rename-member', { name });
      state.me = result.me;                    // set straight away, so a refresh in flight isn't taken for "removed"
      upsertSession(state.room, state.me, '');
      $('who').textContent = `as ${state.me}`;
      $('myname-input').value = state.me;
      if (state.tab !== null && state.data && state.tab === state.data.me) state.tab = state.me;
      await refresh();
      setStatus(`Your name is now ${state.me}.`);
    } catch (err) {
      error.textContent = err.message;
    }
  }

  function onLabelSubmit(event) {
    event.preventDefault();
    const label = $('label-input').value.trim().slice(0, 40);
    if (!label) { $('person-error').textContent = 'Enter a session name.'; $('label-input').focus(); return; }
    $('person-error').textContent = '';
    applyLabel(label);
    setStatus('Session name saved on this device.');
  }

  /* ---------- start screen: start, or join ---------- */

  const HINT_DEFAULT = 'Paste the invite link or the room code you were sent.';
  const HINT_NONE = 'No session found with that code. Check it and try again.';
  const HINT_FAILED = 'Couldn’t look that up. Check your connection and try again.';
  const HINT_FOUND = 'Found it. Tap your name to join, or add yourself below.';

  function clearNames() {
    state.namesTicket += 1; // ignore any lookup still in flight
    $('who-box').hidden = true;
    $('names').replaceChildren();
    $('room-hint').textContent = HINT_DEFAULT;
  }

  // Shows who is in the session (tap to join as them) and a box to add yourself.
  function showWho(list, lookupFailed) {
    if (list.length === 0) {
      $('who-box').hidden = true; // joining never creates a session: typos must not make an empty one
      $('room-hint').textContent = lookupFailed ? HINT_FAILED : HINT_NONE;
      return;
    }
    $('who-box').hidden = false;
    $('names').replaceChildren(...list.map((n) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip';
      chip.textContent = n;
      chip.setAttribute('aria-label', `Join as ${n}`);
      chip.addEventListener('click', () => joinAs(n));
      return chip;
    }));
    $('room-hint').textContent = HINT_FOUND;
  }

  async function loadNames(room) {
    const ticket = ++state.namesTicket;
    const current = () => ticket === state.namesTicket && extractRoom($('room').value) === room;
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
    const room = extractRoom($('room').value);
    if (!room) { clearNames(); return; }
    if ($('room').value.trim() !== room) $('room').value = room; // a pasted link becomes just the code
    namesTimer = setTimeout(() => loadNames(room), 250);
  }

  function setJoining(busy) {
    for (const node of $('who-box').querySelectorAll('button, input')) node.disabled = busy;
  }

  // Join as an existing person (tapped) or add yourself (typed). The server adds new names.
  function joinAs(name) {
    const error = $('join-error');
    error.textContent = '';
    const room = extractRoom($('room').value);
    if (!room) {
      error.textContent = 'Paste the invite link or room code first.';
      $('room').focus();
      return;
    }
    const me = String(name || '').trim();
    if (!me) {
      error.textContent = 'Tap your name above, or enter a new one.';
      $('name').focus();
      return;
    }
    setJoining(true);
    enter(room, me, '')
      .catch((err) => { error.textContent = err.message; })
      .finally(() => setJoining(false));
  }

  function onJoinSubmit(event) {
    event.preventDefault();
    if ($('who-box').hidden) {
      $('join-error').textContent = extractRoom($('room').value) ? HINT_NONE : 'Paste the invite link or room code first.';
      return;
    }
    joinAs($('name').value);
  }

  function onStartSubmit(event) {
    event.preventDefault();
    const error = $('start-error');
    error.textContent = '';
    const me = $('s-name').value.trim();
    if (!me) { error.textContent = 'Enter your name.'; $('s-name').focus(); return; }
    enter(newCode(), me, '').catch((err) => { error.textContent = err.message; });
  }

  /* ---------- in-session actions ---------- */

  async function onAddSubmit(event) {
    event.preventDefault();
    const error = $('add-error');
    const btn = $('add-btn');
    error.textContent = '';
    const text = $('g-text').value.trim();
    if (!text) { error.textContent = 'Enter the gift.'; $('g-text').focus(); return; }
    btn.disabled = true;
    try {
      if (state.editingId) {
        const result = await post('edit', { id: state.editingId, text, link: $('g-link').value, note: $('g-note').value });
        endEdit();
        await refresh(); // refreshing clears the status line, so show ours after it
        setStatus(result.changed ? 'Gift updated.' : 'No changes to save.');
      } else {
        await post('add', { text, link: $('g-link').value, note: $('g-note').value });
        $('g-text').value = '';
        $('g-link').value = '';
        $('g-note').value = '';
        $('g-text').focus();
        await refresh();
      }
    } catch (err) {
      error.textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  }

  // The link carries the room code, and optionally who it is for.
  function inviteLink() {
    const who = cleanName($('invite-for').value);
    const base = `${location.origin}${location.pathname}?room=${encodeURIComponent(state.room)}`;
    return who ? `${base}&as=${encodeURIComponent(who)}` : base;
  }

  function inviteMessage(link) {
    return `Join my Christmas gift lists:\n${link}\n(Room code if you need it: ${state.room})`;
  }

  function updateInvite() {
    const text = inviteMessage(inviteLink());
    const q = encodeURIComponent(text);
    $('invite-wa').href = `https://wa.me/?text=${q}`;
    $('invite-sms').href = `sms:?&body=${q}`;
    $('invite-mail').href = `mailto:?subject=${encodeURIComponent('Join my Christmas gift lists')}&body=${q}`;
    $('invite-share').hidden = !navigator.share;
  }

  // Suggest the people already here, so their name can be picked rather than typed.
  let inviteNamesKey = '';
  function renderInviteNames(ordered) {
    const others = ordered.filter((n) => n !== state.me);
    const key = others.join('\n');
    if (key === inviteNamesKey) return; // don't rebuild while someone is choosing from it
    inviteNamesKey = key;
    $('invite-names').replaceChildren(...others.map((n) => {
      const option = document.createElement('option');
      option.value = n;
      return option;
    }));
  }

  async function shareNative() {
    try {
      await navigator.share({ title: 'Christmas gift lists', text: 'Join my Christmas gift lists', url: inviteLink() });
    } catch (_) { /* closed the share sheet, or it isn't available: the other buttons still work */ }
  }

  function copyInviteLink() {
    return copyText(inviteLink(), 'Invite link copied. Paste it into a message to them.');
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

  // A link made for a particular person: put their name front and centre.
  function showInvitedAs(name) {
    const note = $('invited');
    const chips = [...$('names').children];
    if (name) {
      const match = chips.find((c) => c.textContent.toLowerCase() === name.toLowerCase());
      if (match) {
        match.classList.add('chip-primary');
        note.textContent = `You’ve been invited as ${match.textContent}. Tap ${match.textContent} below to join.`;
        match.focus();
        return;
      }
      if (!$('who-box').hidden) {
        $('name').value = name;
        note.textContent = `You’ve been invited as ${name}. Press “Add me and join” to join as ${name}.`;
        $('join-btn').focus();
        return;
      }
    }
    const first = chips[0] || ($('who-box').hidden ? null : $('name'));
    if (first) first.focus();
  }

  function init() {
    const params = new URLSearchParams(location.search);
    const urlRoom = normaliseRoom(params.get('room'));
    const inviteAs = cleanName(params.get('as'));
    const sessions = loadSessions();

    // Keep the room code out of the address bar, history and referrers.
    if (params.has('room')) history.replaceState(null, '', location.pathname);

    $('start-form').addEventListener('submit', onStartSubmit);
    $('join-form').addEventListener('submit', onJoinSubmit);
    $('room').addEventListener('input', onRoomInput);
    $('name').addEventListener('input', () => { $('join-error').textContent = ''; });
    $('s-name').addEventListener('input', () => { $('start-error').textContent = ''; });
    $('back-btn').addEventListener('click', goBack);
    $('start-instead').addEventListener('click', () => {
      $('start-box').hidden = false;
      $('start-wrap').hidden = true;
      $('s-name').focus();
    });

    $('add-form').addEventListener('submit', onAddSubmit);
    $('person-form').addEventListener('submit', onPersonSubmit);
    $('label-form').addEventListener('submit', onLabelSubmit);
    $('myname-form').addEventListener('submit', onMyNameSubmit);
    $('cancel-edit').addEventListener('click', cancelEdit);
    $('invite').addEventListener('click', () => setInviteOpen($('invite-panel').hidden));
    $('invite-for').addEventListener('input', updateInvite);
    $('invite-share').addEventListener('click', shareNative);
    $('invite-copy').addEventListener('click', copyInviteLink);
    $('copy-code').addEventListener('click', () => copyText(state.room, 'Room code copied. Paste it into Join a session on another device.'));
    $('people-toggle').addEventListener('click', () => setPeopleOpen($('people').hidden));
    $('not-you').addEventListener('click', () => {
      setPeopleOpen(true);
      $('people').scrollIntoView({ block: 'nearest' });
    });
    $('delete-room').addEventListener('click', deleteSession);
    $('tabs').addEventListener('keydown', onTabKeys);
    setupSwipe();

    // Hidden tab: stop the timer so nothing is sent. Visible again: refresh now, then resume.
    document.addEventListener('visibilitychange', () => {
      if (!state.room) return;
      if (document.hidden) { stopPolling(); return; }
      refresh();
      startPolling();
    });

    $('room-hint').textContent = HINT_DEFAULT;
    renderSessions();
    $('s-name').value = lastUsedName();

    // An invite link for a session already saved here opens it straight away.
    // (An invite for a particular person is not opened as someone else who used this device before.)
    const target = urlRoom
      ? sessions.find((s) => s.room === urlRoom && (!inviteAs || s.me.toLowerCase() === inviteAs.toLowerCase()))
      : sessions.find((s) => s.room === normaliseRoom(store.get(STORE_LAST)));
    if (target) { autoEnter(target); return; }

    showScreen('join');
    if (urlRoom) {
      // Came from an invite link: lead with joining, keep "start new" one tap away.
      $('invited').hidden = false;
      $('start-box').hidden = true;
      $('start-wrap').hidden = false;
      $('room').value = urlRoom;
      loadNames(urlRoom).then(() => showInvitedAs(inviteAs));
    }
  }

  init();
})();
