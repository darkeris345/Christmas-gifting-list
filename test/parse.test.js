'use strict';
// Tests for the list parser (public/parse.js). Usage: node test/parse.test.js

const assert = require('node:assert/strict');
const { parseList, parseLine, parseCsv, toLines } = require('../public/parse.js');

let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log(`ok - ${name}`); }
const plain = (items) => items.map(({ text, link, note }) => ({ text, link, note }));

test('one gift per line; bullets, numbers, blanks and # lines are handled', () => {
  const items = parseList('- Socks\n1. Skillet\n2) Torch\n• Book\n\n   \n# My list\nPlain gift');
  assert.deepEqual(items.map((i) => i.text), ['Socks', 'Skillet', 'Torch', 'Book', 'Plain gift']);
});

test('a link anywhere in the line becomes the link', () => {
  assert.deepEqual(plain(parseList('Head torch https://shop.example/torch')), [{ text: 'Head torch', link: 'https://shop.example/torch', note: '' }]);
  assert.deepEqual(plain(parseList('https://shop.example/torch Head torch')), [{ text: 'Head torch', link: 'https://shop.example/torch', note: '' }]);
  assert.deepEqual(plain(parseList('Head torch - https://shop.example/torch')), [{ text: 'Head torch', link: 'https://shop.example/torch', note: '' }]);
});

test('punctuation around a link is not part of it', () => {
  assert.deepEqual(plain(parseList('Book (https://x.example/b).')), [{ text: 'Book', link: 'https://x.example/b', note: '' }]);
  assert.equal(parseLine('See https://x.example/b, please').link, 'https://x.example/b');
});

test('a bare link becomes a gift named after the site', () => {
  assert.deepEqual(plain(parseList('https://www.shop.example/thing')), [{ text: 'shop.example', link: 'https://www.shop.example/thing', note: '' }]);
});

test('text after | is the note, and a link may be in the note', () => {
  assert.deepEqual(plain(parseList('Wool socks | size 42')), [{ text: 'Wool socks', link: '', note: 'size 42' }]);
  assert.deepEqual(plain(parseList('Wool socks | size 42 | https://s.example/x')), [{ text: 'Wool socks', link: 'https://s.example/x', note: 'size 42' }]);
  assert.deepEqual(plain(parseList('Wool socks | size 42 | charcoal')), [{ text: 'Wool socks', link: '', note: 'size 42 · charcoal' }]);
});

test('Windows line endings and odd spacing', () => {
  assert.deepEqual(parseList('A\r\n  B  \r\n\r\nC').map((i) => i.text), ['A', 'B', 'C']);
});

test('non-web schemes stay as plain text and are never made into links', () => {
  const [item] = parseList('javascript:alert(1)');
  assert.equal(item.link, '');
  assert.equal(item.text, 'javascript:alert(1)');
});

test('each item remembers its original line, for fixing skipped ones', () => {
  assert.equal(parseList('  - Socks | size 42  ')[0].source, '- Socks | size 42');
});

test('empty input gives no gifts', () => {
  assert.deepEqual(parseList(''), []);
  assert.deepEqual(parseList(undefined), []);
  assert.deepEqual(parseList('\n\n#only a heading\n-\n---\n* \n'), []);
  assert.deepEqual(parseList('🎁').map((i) => i.text), ['🎁']); // an emoji alone is still a gift
});

test('CSV with a header: columns found by name, link and note by content', () => {
  const csv = 'Gift,Link,Notes\nWool socks,shop.example/socks,size 42\n"Torch, rechargeable",https://s.example/t,\n';
  assert.deepEqual(plain(parseCsv(csv)), [
    { text: 'Wool socks', link: 'https://shop.example/socks', note: 'size 42' },
    { text: 'Torch, rechargeable', link: 'https://s.example/t', note: '' },
  ]);
});

test('CSV with the gift in a later column, semicolons and a BOM', () => {
  const csv = '\uFEFFPrice;Item;URL\n20;Skillet;https://x.example/s\n';
  assert.deepEqual(plain(parseCsv(csv)), [{ text: 'Skillet', link: 'https://x.example/s', note: '20' }]);
});

test('CSV without a header, with quotes and doubled quotes', () => {
  const csv = 'Book,"He said ""hi"""\r\nSocks\r\n';
  assert.deepEqual(plain(parseCsv(csv)), [
    { text: 'Book', link: '', note: 'He said "hi"' },
    { text: 'Socks', link: '', note: '' },
  ]);
});

test('CSV: a link inside the gift text is pulled out; empty rows are skipped', () => {
  const csv = 'Gift\nHead torch https://s.example/t\n,\n\n';
  assert.deepEqual(plain(parseCsv(csv)), [{ text: 'Head torch', link: 'https://s.example/t', note: '' }]);
});

test('toLines gives lines that parse back to the same gifts', () => {
  const items = parseCsv('Gift,Link,Notes\nWool socks,shop.example/socks,size 42\nSkillet,,26 cm\nBook,,\n');
  const again = parseList(toLines(items).join('\n'));
  assert.deepEqual(plain(again), plain(items));
});

console.log(`\n${passed} parser tests passed`);
