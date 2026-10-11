const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../js/core.js');

test('haversine: Paris to London is ~344 km', () => {
  const d = Core.haversine({ lat: 48.8566, lon: 2.3522 }, { lat: 51.5074, lon: -0.1278 });
  assert.ok(Math.abs(d - 343500) < 2000, d);
});

test('geometric median of a symmetric square is its centre', () => {
  const m = Core.geometricMedian([
    { lat: 0, lon: 0 }, { lat: 0, lon: 0.02 }, { lat: 0.02, lon: 0 }, { lat: 0.02, lon: 0.02 },
  ]);
  assert.ok(Math.abs(m.lat - 0.01) < 1e-6 && Math.abs(m.lon - 0.01) < 1e-6);
});

test('geometric median resists an outlier better than the mean', () => {
  const pts = [{ lat: 0, lon: 0 }, { lat: 0, lon: 0.001 }, { lat: 0.001, lon: 0 }, { lat: 0, lon: 1 }];
  const m = Core.geometricMedian(pts);
  const mean = { lat: pts.reduce((s, p) => s + p.lat, 0) / 4, lon: pts.reduce((s, p) => s + p.lon, 0) / 4 };
  assert.ok(Core.averageDistance(m, pts) < Core.averageDistance(mean, pts));
});

test('geometric median works across the antimeridian', () => {
  const m = Core.geometricMedian([{ lat: -17, lon: 179.9 }, { lat: -17, lon: -179.9 }]);
  assert.ok(Math.abs(Math.abs(m.lon) - 180) < 0.2, m.lon);
});

test('parseDescription maps words to styles and keeps extra keywords', () => {
  const r = Core.parseDescription('I love sushi, ancient ruins and sunset views. Jazz bars too!');
  assert.ok(r.styles.includes('history'));
  assert.ok(r.styles.includes('viewpoints'));
  assert.ok(r.styles.includes('nightlife'));
  assert.ok(r.extra.includes('sushi'));
  assert.ok(r.extra.includes('jazz'));
  assert.ok(!r.extra.includes('love'));
});

test('parseDescription understands Hebrew', () => {
  const r = Core.parseDescription('אני אוהב חופים, מוזיאונים ובתי קפה');
  assert.ok(r.styles.includes('beaches'));
  assert.ok(r.styles.includes('museums'));
  assert.ok(r.styles.includes('cafes'));
});

test('buildOverpassQuery creates one statement per filter and centre, escaping keywords', () => {
  const f = Core.filtersFor(['museums'], ['sa"ke']);
  const q = Core.buildOverpassQuery(f, [{ lat: 1, lon: 2 }, { lat: 3, lon: 4 }], 1000);
  assert.match(q, /^\[out:json\]/);
  assert.equal((q.match(/nwr/g) || []).length, f.length * 2);
  assert.ok(q.includes('sa\\"ke'));
  assert.ok(q.trim().endsWith('out center tags;'));
});

test('classify and toPoi', () => {
  assert.equal(Core.classify({ tourism: 'museum' }), 'museums');
  assert.equal(Core.classify({ amenity: 'pub' }), 'nightlife');
  assert.equal(Core.classify({ natural: 'beach' }), 'beaches');
  assert.equal(Core.classify({ historic: 'castle' }), 'history');
  assert.equal(Core.toPoi({ type: 'node', id: 1, lat: 1, lon: 2, tags: {} }), null);
  const p = Core.toPoi({ type: 'way', id: 2, center: { lat: 1, lon: 2 }, tags: { name: 'X', tourism: 'viewpoint' } });
  assert.equal(p.id, 'way/2');
  assert.equal(p.style, 'viewpoints');
});

test('rankPois prefers notable, close POIs and de-duplicates by name', () => {
  const a = { lat: 0, lon: 0, name: 'A' };
  const pois = [
    Core.toPoi({ type: 'node', id: 1, lat: 0.001, lon: 0, tags: { name: 'Small cafe', amenity: 'cafe' } }),
    Core.toPoi({ type: 'node', id: 2, lat: 0.005, lon: 0, tags: { name: 'Big Museum', tourism: 'museum', wikidata: 'Q1', wikipedia: 'en:Big' } }),
    Core.toPoi({ type: 'way', id: 3, center: { lat: 0.0051, lon: 0 }, tags: { name: 'Big Museum', tourism: 'museum' } }),
  ];
  const r = Core.rankPois(pois, [a], { radius: 1500 });
  assert.equal(r.length, 2);
  assert.equal(r[0].name, 'Big Museum');
  assert.equal(r[0].id, 'node/2');
  assert.equal(r[0].near, a);
});

test('rankHotels orders by average distance and applies star filter', () => {
  const places = [{ lat: 0, lon: 0 }, { lat: 0, lon: 0.02 }];
  const mk = (id, lon, tags = {}) => Core.toPoi({ type: 'node', id, lat: 0, lon, tags: { name: 'H' + id, tourism: 'hotel', ...tags } });
  const hotels = [mk(1, -0.01), mk(2, 0.01, { stars: '3' }), mk(3, 0.05, { stars: '5' })];
  const r = Core.rankHotels(hotels, places);
  assert.equal(r[0].name, 'H2');
  assert.equal(r.at(-1).name, 'H3');
  const four = Core.rankHotels(hotels, places, { minStars: 4 });
  assert.deepEqual(four.map((h) => h.name), ['H3']);
});

test('formatDistance', () => {
  assert.equal(Core.formatDistance(234), '230 m');
  assert.equal(Core.formatDistance(1530), '1.5 km');
  assert.equal(Core.formatDistance(25400), '25 km');
});
