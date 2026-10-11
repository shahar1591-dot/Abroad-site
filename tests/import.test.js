const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../js/core.js');

test('parseMapsUrl reads exact pins, @viewport, ?q= and place names', () => {
  const a = Core.parseMapsUrl('https://www.google.com/maps/place/Colosseo/@41.8902102,12.4900422,17z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d41.8902102!4d12.4922309');
  assert.equal(a.name, 'Colosseo');
  assert.equal(a.lat, 41.8902102);
  assert.equal(a.lon, 12.4922309); // !4d wins over @ viewport
  const b = Core.parseMapsUrl('https://maps.google.com/?q=35.6586,139.7454');
  assert.deepEqual([b.lat, b.lon], [35.6586, 139.7454]);
  const c = Core.parseMapsUrl('https://www.google.com/maps/search/?api=1&query=Sagrada+Familia');
  assert.equal(c.name, 'Sagrada Familia');
  assert.equal(c.lat, undefined);
  const d = Core.parseMapsUrl('https://www.google.com/maps/place/Caf%C3%A9+de+Flore/@48.854,2.3325,17z');
  assert.equal(d.name, 'Café de Flore');
  assert.equal(Core.parseMapsUrl('https://maps.app.goo.gl/AbCdEf123'), null);
});

test('parseSavedCsv handles Google Takeout saved list format', () => {
  const csv = 'Title,Note,URL,Tags,Comment\n' +
    ',,,,\n' +
    'Louvre Museum,"Go early, buy tickets",https://www.google.com/maps/place/Louvre+Museum/data=!4m2!3m1!1s0x47e671d877937b0f:0xb975fcfa192f84d4,,\n' +
    '"Shakespeare and Company","Books ""and"" coffee","https://www.google.com/maps/place/Shakespeare+and+Company/@48.8525,2.3471,17z/data=!3d48.8525728!4d2.3470692",,\n' +
    'Dropped pin,,"https://www.google.com/maps/search/48.8606,2.3376",,\n';
  const r = Core.parseSavedCsv(csv);
  assert.equal(r.length, 3);
  assert.equal(r[0].name, 'Louvre Museum');
  assert.equal(r[0].lat, undefined);           // needs a lookup by name
  assert.equal(r[0].note, 'Go early, buy tickets');
  assert.equal(r[1].note, 'Books "and" coffee');
  assert.equal(r[1].lat, 48.8525728);
  assert.deepEqual([r[2].lat, r[2].lon], [48.8606, 2.3376]);
});

test('parseSavedCsv also accepts generic name/lat/lon CSV', () => {
  const r = Core.parseSavedCsv('name,latitude,longitude\r\nBig Ben,51.5007,-0.1246\r\n');
  assert.deepEqual(r, [{ name: 'Big Ben', address: undefined, note: undefined, url: undefined, lat: 51.5007, lon: -0.1246 }]);
});

test('parseSavedGeoJson handles new and old Takeout shapes and [0,0] placeholders', () => {
  const json = {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', geometry: { type: 'Point', coordinates: [139.7454, 35.6586] },
        properties: { google_maps_url: 'http://maps.google.com/?cid=1', location: { name: 'Tokyo Tower', address: '4 Chome-2-8 Shibakoen, Tokyo' } } },
      { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] },
        properties: { google_maps_url: 'http://maps.google.com/?q=Senso-ji&ftid=0x0', location: { name: 'Senso-ji', address: 'Asakusa, Tokyo' } } },
      { type: 'Feature', geometry: { type: 'Point', coordinates: [-73.9857, 40.7484] },
        properties: { Title: 'Empire State Building', 'Google Maps URL': 'http://maps.google.com/?cid=2',
          Location: { Address: '20 W 34th St, New York', 'Business Name': 'Empire State Building', 'Geo Coordinates': { Latitude: '40.7484', Longitude: '-73.9857' } } } },
    ],
  };
  const r = Core.parseSavedGeoJson(JSON.stringify(json));
  assert.equal(r.length, 3);
  assert.deepEqual([r[0].name, r[0].lat, r[0].lon], ['Tokyo Tower', 35.6586, 139.7454]);
  assert.equal(r[1].name, 'Senso-ji');
  assert.equal(r[1].lat, undefined);
  assert.equal(r[2].name, 'Empire State Building');
  assert.equal(r[2].lon, -73.9857);
});

test('parseKml reads My Maps placemarks and skips lines', () => {
  const kml = `<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>Rome</name>
    <Folder><name>Layer</name>
    <Placemark><name>Trevi Fountain</name><description><![CDATA[Throw a coin <br>at night]]></description>
      <Point><coordinates>12.4833,41.9009,0</coordinates></Point></Placemark>
    <Placemark><name>Route</name><LineString><coordinates>12.1,41.1,0 12.2,41.2,0</coordinates></LineString></Placemark>
    <Placemark><name>Pizza &amp; Co</name><Point><coordinates>
      12.47,41.89,0
    </coordinates></Point></Placemark>
    </Folder></Document></kml>`;
  const r = Core.parseKml(kml);
  assert.equal(r.length, 2);
  assert.deepEqual([r[0].name, r[0].lat, r[0].lon], ['Trevi Fountain', 41.9009, 12.4833]);
  assert.equal(r[0].note, 'Throw a coin at night');
  assert.equal(r[1].name, 'Pizza & Co');
});

test('parsePastedList mixes links, names, coordinates and bullets', () => {
  const r = Core.parsePastedList([
    '1. https://www.google.com/maps/place/Pantheon/@41.8986,12.4769,17z',
    '- Trevi Fountain',
    '41.9029, 12.4534',
    'Gelato spot - https://maps.app.goo.gl/xyz',
    'https://maps.app.goo.gl/abc',
    '',
  ].join('\n'));
  assert.equal(r.length, 5);
  assert.deepEqual([r[0].name, r[0].lat], ['Pantheon', 41.8986]);
  assert.equal(r[1].name, 'Trevi Fountain');
  assert.deepEqual([r[2].lat, r[2].lon], [41.9029, 12.4534]);
  assert.equal(r[3].name, 'Gelato spot');   // label rescues an unreadable short link
  assert.ok(!r[3].unresolved);
  assert.ok(r[4].unresolved);
});

test('parseImportFile picks the parser by name or content', () => {
  assert.equal(Core.parseImportFile('Want to go.csv', 'Title,Note,URL\nX,,\n')[0].name, 'X');
  assert.equal(Core.parseImportFile('Saved Places.json', '{"features":[]}').length, 0);
  assert.equal(Core.parseImportFile('map.kml', '<kml><Placemark><name>A</name><Point><coordinates>1,2</coordinates></Point></Placemark></kml>')[0].lat, 2);
});
