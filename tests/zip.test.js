const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Core = require('../js/core.js');

const zip = fs.readFileSync(path.join(__dirname, 'fixtures', 'takeout.zip'));

test('isZip recognises zip bytes only', () => {
  assert.ok(Core.isZip(new Uint8Array(zip)));
  assert.ok(!Core.isZip(new TextEncoder().encode('Title,Note,URL')));
});

test('readZip extracts deflated and stored entries, with UTF-8 names, honouring the filter', async () => {
  const entries = await Core.readZip(new Uint8Array(zip), (p) => /\.(csv|json|kml)$/i.test(p));
  const paths = entries.map((e) => e.path).sort();
  assert.deepEqual(paths, [
    'Takeout/Maps (your places)/Saved Places.json',
    'Takeout/Profile/Profile.json',
    'Takeout/Saved/Want to go.csv',
    'Takeout/Saved/מסעדות ברומא.csv',
  ]);
  const want = entries.find((e) => e.path.endsWith('Want to go.csv'));
  assert.match(want.text, /Throw a coin/);
});

test('a whole Takeout zip turns into named lists of places; unrelated JSON yields nothing', async () => {
  const entries = await Core.readZip(new Uint8Array(zip), (p) => /\.(csv|json)$/i.test(p));
  const lists = {};
  for (const e of entries) {
    const items = Core.parseImportFile(e.path, e.text);
    if (items.length) lists[Core.listNameFromPath(e.path)] = items;
  }
  assert.deepEqual(Object.keys(lists).sort(), ['Saved Places', 'Want to go', 'מסעדות ברומא']);
  assert.equal(lists['Want to go'].length, 2);
  assert.equal(lists['Want to go'][0].lat, 41.8902102);
  assert.equal(lists['Want to go'][1].lat, undefined);
  assert.equal(lists['Saved Places'][0].name, 'Pantheon');
});

test('readZip rejects non-zip data', async () => {
  await assert.rejects(Core.readZip(new TextEncoder().encode('hello world, definitely not a zip file at all')), /zip/);
});
