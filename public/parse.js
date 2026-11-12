/* Turns pasted text, or a CSV file, into gifts. Plain functions, no page access,
   so they can be tested on their own.

   Pasted text, one gift per line:
     Wool socks | size 42
     Cast iron skillet
     Head torch https://shop.example/torch
     - bullets and 1. numbers are fine
   A link can sit anywhere in the line. Everything after a | is the note.
   Blank lines and lines starting with # are ignored. */
(function (root) {
  'use strict';

  const URL_RE = /https?:\/\/[^\s<>"]+/i;
  const BULLET_RE = /^(?:[-*•–—]\s+|\d{1,3}[.)]\s+)/;
  const NAME_HEADERS = ['gift', 'name', 'item', 'present', 'title', 'what', 'idea'];

  function hostOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch (_) { return url; }
  }

  // Pulls the first web link out of some text. Returns the link and what is left.
  function takeUrl(text) {
    const m = String(text).match(URL_RE);
    if (!m) return { url: '', rest: String(text).trim() };
    const url = m[0].replace(/[.,;:!?)\]]+$/, '');
    const rest = (text.slice(0, m.index) + ' ' + text.slice(m.index + m[0].length))
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^[-–—:,·]\s*/, '')
      .replace(/\s*[-–—:,·(\[]\s*$/, '')
      .trim();
    return { url, rest };
  }

  function parseLine(line) {
    let s = String(line).trim();
    if (!s || s[0] === '#') return null;
    s = s.replace(BULLET_RE, '').trim();
    // Nothing but punctuation (an empty bullet, a "---" divider): not a gift.
    if (!/[\p{L}\p{N}\p{Extended_Pictographic}]/u.test(s)) return null;

    const [first, ...others] = s.split('|').map((part) => part.trim());
    let { url, rest: text } = takeUrl(first);
    let note = others.filter(Boolean).join(' · ');
    if (!url && note) {
      const fromNote = takeUrl(note);
      url = fromNote.url;
      note = fromNote.rest;
    }
    if (!text && url) text = hostOf(url);
    if (!text) return null;
    return { text, link: url, note, source: String(line).trim() };
  }

  function parseList(text) {
    return String(text || '').split(/\r?\n/).map(parseLine).filter(Boolean);
  }

  /* ---------- CSV ---------- */

  // Small CSV reader: quotes, doubled quotes, and comma, semicolon or tab separators.
  function csvRows(text) {
    const rows = [];
    let row = [];
    let cell = '';
    let quoted = false;
    const src = String(text || '').replace(/^\uFEFF/, '');
    for (let i = 0; i < src.length; i += 1) {
      const c = src[i];
      if (quoted) {
        if (c === '"') {
          if (src[i + 1] === '"') { cell += '"'; i += 1; } else quoted = false;
        } else cell += c;
      } else if (c === '"') quoted = true;
      else if (c === ',' || c === ';' || c === '\t') { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && src[i + 1] === '\n') i += 1;
        row.push(cell);
        rows.push(row);
        row = [];
        cell = '';
      } else cell += c;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows.filter((r) => r.some((x) => x.trim()));
  }

  const looksLikeUrl = (s) =>
    /^https?:\/\/\S+$/i.test(s) || /^(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/\S*)?$/i.test(s);
  const withScheme = (s) => (/^https?:\/\//i.test(s) ? s : `https://${s}`);

  // Gift in one column (found by its header, or the first column); any cell that
  // looks like a web address is the link; the other cells become the note.
  function parseCsv(text) {
    let rows = csvRows(text);
    if (rows.length === 0) return [];
    let giftCol = 0;
    const head = rows[0].map((c) => c.trim().toLowerCase());
    const headerAt = head.findIndex((c) => NAME_HEADERS.includes(c));
    if (headerAt >= 0) { giftCol = headerAt; rows = rows.slice(1); }

    const items = [];
    for (const row of rows) {
      const cells = row.map((c) => c.trim());
      const text0 = cells[giftCol] || '';
      let link = '';
      const notes = [];
      cells.forEach((cell, i) => {
        if (i === giftCol || !cell) return;
        if (!link && looksLikeUrl(cell)) link = withScheme(cell);
        else notes.push(cell);
      });
      let gift = text0;
      const inText = takeUrl(gift);
      if (!link && inText.url) { link = inText.url; gift = inText.rest; }
      if (!gift && link) gift = hostOf(link);
      if (!gift) continue;
      const note = notes.join(' · ');
      items.push({ text: gift, link, note, source: row.join(', ') });
    }
    return items;
  }

  // Back to editable lines, so an uploaded file can be reviewed before adding.
  function toLines(items) {
    return items.map((it) => `${it.text}${it.link ? ` ${it.link}` : ''}${it.note ? ` | ${it.note}` : ''}`);
  }

  const api = { parseList, parseLine, parseCsv, toLines };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GiftParser = api;
}(typeof self !== 'undefined' ? self : this));
