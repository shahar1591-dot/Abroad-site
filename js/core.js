/*
 * Pure logic for Abroad: geo math, attraction styles, Overpass query building,
 * ranking. No DOM access, so it can be unit-tested in Node.
 */
(function (root) {
  'use strict';

  const EARTH_RADIUS_M = 6371008.8;
  const toRad = (d) => (d * Math.PI) / 180;

  /** Great-circle distance in meters between {lat, lon} points. */
  function haversine(a, b) {
    const dLat = toRad(b.lat - a.lat);
    const dLon = toRad(b.lon - a.lon);
    const h =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function averageDistance(point, places) {
    if (!places.length) return 0;
    return places.reduce((sum, p) => sum + haversine(point, p), 0) / places.length;
  }

  /**
   * Geometric median (the point minimising the average distance to all places),
   * via Weiszfeld's algorithm on a local equirectangular projection. Handles
   * longitudes across the antimeridian by unwrapping around the first place.
   */
  function geometricMedian(places) {
    if (!places.length) return null;
    if (places.length === 1) return { lat: places[0].lat, lon: places[0].lon };

    const lon0 = places[0].lon;
    const unwrap = (lon) => {
      let d = lon - lon0;
      while (d > 180) d -= 360;
      while (d < -180) d += 360;
      return lon0 + d;
    };
    const pts = places.map((p) => ({ lat: p.lat, lon: unwrap(p.lon) }));
    const meanLat = pts.reduce((s, p) => s + p.lat, 0) / pts.length;
    const kx = Math.cos(toRad(meanLat));
    const xy = pts.map((p) => ({ x: p.lon * kx, y: p.lat }));

    let x = xy.reduce((s, p) => s + p.x, 0) / xy.length;
    let y = xy.reduce((s, p) => s + p.y, 0) / xy.length;
    for (let i = 0; i < 200; i++) {
      let nx = 0, ny = 0, wsum = 0;
      for (const p of xy) {
        const d = Math.hypot(p.x - x, p.y - y);
        if (d < 1e-9) continue; // sitting on a vertex; skip its weight
        const w = 1 / d;
        nx += p.x * w;
        ny += p.y * w;
        wsum += w;
      }
      if (!wsum) break;
      nx /= wsum;
      ny /= wsum;
      const moved = Math.hypot(nx - x, ny - y);
      x = nx;
      y = ny;
      if (moved < 1e-9) break;
    }
    let lon = x / kx;
    while (lon > 180) lon -= 360;
    while (lon < -180) lon += 360;
    return { lat: y, lon };
  }

  function formatDistance(m) {
    if (m < 1000) return `${Math.round(m / 10) * 10} m`;
    if (m < 10000) return `${(m / 1000).toFixed(1)} km`;
    return `${Math.round(m / 1000)} km`;
  }

  /** Rough walking time at 4.8 km/h, with a 1.25 detour factor for straight lines. */
  function walkingMinutes(m) {
    return Math.max(1, Math.round((m * 1.25) / 80));
  }

  // ---------------------------------------------------------------------------
  // Attraction styles -> OpenStreetMap tag filters (Overpass QL)
  // ---------------------------------------------------------------------------

  const STYLES = {
    landmarks: {
      label: 'Famous landmarks', icon: '⭐', color: '#e8a317',
      filters: ['["tourism"="attraction"]', '["historic"]["wikidata"]', '["man_made"~"^(tower|lighthouse)$"]["tourism"]'],
    },
    museums: {
      label: 'Museums', icon: '🏛️', color: '#7b4fd6',
      filters: ['["tourism"="museum"]'],
    },
    history: {
      label: 'History & ruins', icon: '🏰', color: '#a0522d',
      filters: ['["historic"~"^(castle|ruins|archaeological_site|fort|city_gate|palace|monument|memorial|manor|citywalls|battlefield)$"]["name"]'],
    },
    art: {
      label: 'Art & galleries', icon: '🎨', color: '#d6336c',
      filters: ['["tourism"="gallery"]', '["amenity"="arts_centre"]', '["tourism"="artwork"]["name"]', '["amenity"="theatre"]'],
    },
    nature: {
      label: 'Nature & parks', icon: '🌳', color: '#2f9e44',
      filters: ['["leisure"~"^(park|garden|nature_reserve)$"]["name"]', '["natural"~"^(peak|waterfall|cave_entrance|spring|volcano)$"]["name"]', '["boundary"="national_park"]'],
    },
    viewpoints: {
      label: 'Views & sunsets', icon: '🌄', color: '#f76707',
      filters: ['["tourism"="viewpoint"]'],
    },
    food: {
      label: 'Food & markets', icon: '🍜', color: '#e03131',
      filters: ['["amenity"="marketplace"]', '["amenity"="restaurant"]["name"]["cuisine"]', '["amenity"="food_court"]', '["shop"~"^(bakery|pastry|deli|cheese|chocolate)$"]["name"]'],
    },
    cafes: {
      label: 'Cafés', icon: '☕', color: '#8d6e63',
      filters: ['["amenity"="cafe"]["name"]'],
    },
    nightlife: {
      label: 'Nightlife & bars', icon: '🍸', color: '#5c3bd6',
      filters: ['["amenity"~"^(bar|pub|nightclub|biergarten)$"]["name"]', '["craft"~"^(brewery|winery)$"]'],
    },
    beaches: {
      label: 'Beaches', icon: '🏖️', color: '#1c9bd6',
      filters: ['["natural"="beach"]', '["leisure"="beach_resort"]'],
    },
    religious: {
      label: 'Sacred places', icon: '🕍', color: '#5f6b7a',
      filters: ['["amenity"="place_of_worship"]["wikidata"]', '["amenity"="place_of_worship"]["historic"]', '["amenity"="place_of_worship"]["tourism"]'],
    },
    family: {
      label: 'Family & fun', icon: '🎡', color: '#ff6b9d',
      filters: ['["tourism"~"^(theme_park|zoo|aquarium)$"]', '["leisure"="water_park"]', '["attraction"="amusement_ride"]["name"]'],
    },
    shopping: {
      label: 'Shopping', icon: '🛍️', color: '#0ca678',
      filters: ['["shop"~"^(mall|department_store)$"]', '["shop"~"^(gift|souvenir|antiques|art|books)$"]["name"]["wikidata"]'],
    },
  };

  // Free-text keyword -> style key. English plus a few Hebrew, Spanish, French words.
  const KEYWORDS = {
    landmarks: ['landmark', 'landmarks', 'famous', 'iconic', 'sightseeing', 'sights', 'must', 'architecture', 'tourist', 'attraction', 'attractions', 'אטרקציות', 'אטרקציה', 'אתרים'],
    museums: ['museum', 'museums', 'exhibition', 'exhibitions', 'science', 'מוזיאון', 'מוזיאונים', 'museo', 'musée'],
    history: ['history', 'historic', 'historical', 'ancient', 'castle', 'castles', 'ruins', 'medieval', 'monument', 'monuments', 'archaeology', 'palace', 'palaces', 'fort', 'היסטוריה', 'היסטורי', 'עתיק', 'עתיקות', 'טירה', 'טירות', 'historia', 'histoire', 'château'],
    art: ['art', 'arts', 'gallery', 'galleries', 'painting', 'paintings', 'sculpture', 'theatre', 'theater', 'opera', 'culture', 'cultural', 'אמנות', 'גלריה', 'גלריות', 'תרבות', 'תיאטרון', 'arte'],
    nature: ['nature', 'park', 'parks', 'garden', 'gardens', 'hike', 'hiking', 'trek', 'forest', 'mountain', 'mountains', 'lake', 'lakes', 'waterfall', 'waterfalls', 'outdoor', 'outdoors', 'green', 'botanical', 'cave', 'caves', 'טבע', 'פארק', 'פארקים', 'גן', 'גנים', 'טיול', 'טיולים', 'הרים', 'מפל', 'אגם', 'naturaleza', 'parque'],
    viewpoints: ['view', 'views', 'viewpoint', 'viewpoints', 'sunset', 'sunsets', 'sunrise', 'panorama', 'panoramic', 'scenic', 'photo', 'photos', 'photography', 'instagram', 'נוף', 'נופים', 'תצפית', 'תצפיות', 'שקיעה', 'mirador'],
    food: ['food', 'foodie', 'eat', 'eating', 'restaurant', 'restaurants', 'cuisine', 'market', 'markets', 'dining', 'bakery', 'dessert', 'desserts', 'אוכל', 'מסעדה', 'מסעדות', 'שוק', 'שווקים', 'קולינריה', 'comida', 'mercado', 'marché', 'cuisine'],
    cafes: ['cafe', 'cafes', 'café', 'cafés', 'coffee', 'brunch', 'breakfast', 'קפה', 'בית קפה', 'בתי קפה'],
    nightlife: ['nightlife', 'night', 'bar', 'bars', 'pub', 'pubs', 'club', 'clubs', 'clubbing', 'party', 'parties', 'drinks', 'beer', 'wine', 'cocktail', 'cocktails', 'brewery', 'winery', 'חיי לילה', 'בר', 'ברים', 'פאב', 'מסיבות', 'בירה', 'יין', 'fiesta'],
    beaches: ['beach', 'beaches', 'sea', 'ocean', 'swim', 'swimming', 'surf', 'surfing', 'coast', 'coastal', 'sand', 'snorkel', 'snorkeling', 'חוף', 'חופים', 'ים', 'playa', 'plage'],
    religious: ['church', 'churches', 'cathedral', 'cathedrals', 'temple', 'temples', 'mosque', 'mosques', 'synagogue', 'synagogues', 'religious', 'spiritual', 'shrine', 'shrines', 'monastery', 'כנסייה', 'כנסיות', 'מקדש', 'מקדשים', 'מסגד', 'בית כנסת', 'iglesia', 'église'],
    family: ['kids', 'kid', 'children', 'family', 'families', 'zoo', 'zoos', 'aquarium', 'theme', 'amusement', 'rides', 'waterpark', 'ילדים', 'משפחה', 'משפחות', 'גן חיות', 'אקווריום', 'לונה פארק'],
    shopping: ['shopping', 'shop', 'shops', 'mall', 'malls', 'boutique', 'boutiques', 'souvenir', 'souvenirs', 'fashion', 'vintage', 'antiques', 'קניות', 'קניון', 'קניונים', 'חנויות', 'מזכרות', 'compras'],
  };

  const STOPWORDS = new Set((
    'i me my we our you the a an and or but to of in on at for with like love really very much ' +
    'enjoy want would also some any lots lot things thing stuff place places good great nice best ' +
    'see visit visiting go going trip travel travelling traveling around near close not no is are am be ' +
    'that this these those it its from into about more most less just only kind sort type style styles ' +
    'quiet cheap expensive fun cool beautiful amazing'
  ).split(/\s+/));

  /**
   * Turn a free-text description into style keys plus leftover keywords that
   * can be searched directly (e.g. "sushi", "jazz").
   */
  function parseDescription(text) {
    const styles = new Set();
    const extra = [];
    if (!text || !text.trim()) return { styles: [], extra: [] };
    const lower = ' ' + text.toLowerCase().replace(/[.,;:!?()"'/\\]+/g, ' ').replace(/\s+/g, ' ') + ' ';

    for (const [style, words] of Object.entries(KEYWORDS)) {
      for (const w of words) {
        if (lower.includes(' ' + w + ' ') || (w.includes(' ') && lower.includes(w))) {
          styles.add(style);
          break;
        }
      }
    }
    const known = new Set(Object.values(KEYWORDS).flat());
    for (const token of lower.trim().split(' ')) {
      if (token.length < 4 || STOPWORDS.has(token) || known.has(token)) continue;
      if (!/^[\p{L}-]+$/u.test(token)) continue;
      if (!extra.includes(token)) extra.push(token);
    }
    return { styles: [...styles], extra: extra.slice(0, 6) };
  }

  /** Escape a user keyword for use inside an Overpass regex string. */
  function escapeRegex(s) {
    return s.replace(/[\\^$.*+?()[\]{}|"]/g, '\\$&');
  }

  /**
   * Build one Overpass query that fetches the given filters around every center.
   * centers: [{lat, lon}], radius in meters.
   */
  function buildOverpassQuery(filters, centers, radius, timeout = 25) {
    const parts = [];
    for (const c of centers) {
      const around = `(around:${Math.round(radius)},${c.lat.toFixed(6)},${c.lon.toFixed(6)})`;
      for (const f of filters) parts.push(`  nwr${f}${around};`);
    }
    return `[out:json][timeout:${timeout}];\n(\n${parts.join('\n')}\n);\nout center tags;`;
  }

  function filtersFor(styleKeys, extraKeywords) {
    const filters = [];
    for (const k of styleKeys) if (STYLES[k]) filters.push(...STYLES[k].filters);
    for (const kw of extraKeywords || []) {
      const re = escapeRegex(kw);
      filters.push(`["cuisine"~"${re}",i]`);
      filters.push(`["tourism"]["name"~"${re}",i]`);
      filters.push(`["amenity"~"^(bar|pub|restaurant|cafe|nightclub|theatre|arts_centre)$"]["name"~"${re}",i]`);
    }
    return [...new Set(filters)];
  }

  /** Which style does an OSM element belong to? (first match wins) */
  function classify(tags) {
    const t = tags || {};
    const is = (k, re) => t[k] !== undefined && re.test(t[k]);
    if (is('tourism', /^(theme_park|zoo|aquarium)$/) || t.leisure === 'water_park' || t.attraction === 'amusement_ride') return 'family';
    if (t.tourism === 'museum') return 'museums';
    if (t.tourism === 'viewpoint') return 'viewpoints';
    if (t.natural === 'beach' || t.leisure === 'beach_resort') return 'beaches';
    if (t.amenity === 'place_of_worship') return 'religious';
    if (t.tourism === 'gallery' || t.tourism === 'artwork' || is('amenity', /^(arts_centre|theatre)$/)) return 'art';
    if (is('amenity', /^(bar|pub|nightclub|biergarten)$/) || is('craft', /^(brewery|winery)$/)) return 'nightlife';
    if (t.amenity === 'cafe') return 'cafes';
    if (is('amenity', /^(restaurant|marketplace|food_court|fast_food)$/) || is('shop', /^(bakery|pastry|deli|cheese|chocolate)$/)) return 'food';
    if (t.shop) return 'shopping';
    if (t.leisure || t.natural || t.boundary === 'national_park') return 'nature';
    if (t.historic) return 'history';
    return 'landmarks';
  }

  /** Normalise an Overpass element into a flat POI, or null if unusable. */
  function toPoi(el) {
    const tags = el.tags || {};
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (lat === undefined || lon === undefined) return null;
    const name = tags['name:en'] || tags.name || tags['name:int'];
    if (!name) return null;
    return { id: `${el.type}/${el.id}`, osmType: el.type, osmId: el.id, name, lat, lon, tags, style: classify(tags) };
  }

  /** How "worth visiting" a POI looks from its tags alone. */
  function notability(tags) {
    let s = 0;
    if (tags.wikidata) s += 3;
    if (tags.wikipedia) s += 2;
    if (tags.tourism === 'attraction') s += 1;
    if (tags.heritage) s += 1.5;
    if (tags.image || tags.wikimedia_commons) s += 0.5;
    if (tags.website || tags['contact:website']) s += 0.5;
    if (tags.opening_hours) s += 0.3;
    if (tags['name:en'] && tags.name && tags['name:en'] !== tags.name) s += 0.5; // has international audience
    return s;
  }

  /**
   * Rank POIs by notability and closeness to the nearest anchor, de-duplicating
   * by id and name. Each returned POI carries `near` (anchor) and `distance`.
   */
  function rankPois(pois, anchors, { radius = 1500, limit = 60, preferredStyles = [], excludeIds = new Set() } = {}) {
    const seenIds = new Set();
    const seenNames = new Map();
    const scored = [];
    const preferred = new Set(preferredStyles);

    for (const p of pois) {
      if (!p || seenIds.has(p.id) || excludeIds.has(p.id)) continue;
      seenIds.add(p.id);
      let near = null, best = Infinity;
      for (const a of anchors) {
        const d = haversine(p, a);
        if (d < best) { best = d; near = a; }
      }
      const proximity = 1 - Math.min(1, best / Math.max(radius, 1)); // 0..1
      const score = notability(p.tags) + proximity * 2 + (preferred.has(p.style) ? 1 : 0);
      const item = { ...p, near, distance: best, score };

      // Merge duplicates (e.g. a node and a way for the same museum) by name.
      const key = p.name.toLowerCase();
      const prev = seenNames.get(key);
      if (prev && haversine(prev, p) < 300) {
        if (item.score > prev.score) {
          scored[scored.indexOf(prev)] = item;
          seenNames.set(key, item);
        }
        continue;
      }
      seenNames.set(key, item);
      scored.push(item);
    }
    scored.sort((a, b) => b.score - a.score);

    // Keep variety: no style may take more than ~40% of the list.
    const cap = Math.max(4, Math.ceil(limit * 0.4));
    const perStyle = {};
    const out = [];
    for (const p of scored) {
      perStyle[p.style] = (perStyle[p.style] || 0) + 1;
      if (perStyle[p.style] > cap) continue;
      out.push(p);
      if (out.length >= limit) break;
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Hotels
  // ---------------------------------------------------------------------------

  const LODGING = {
    hotel: { label: 'Hotels', filter: '["tourism"="hotel"]' },
    guest_house: { label: 'Guest houses & B&Bs', filter: '["tourism"~"^(guest_house|bed_and_breakfast)$"]' },
    apartment: { label: 'Apartments', filter: '["tourism"="apartment"]' },
    hostel: { label: 'Hostels', filter: '["tourism"="hostel"]' },
    motel: { label: 'Motels', filter: '["tourism"="motel"]' },
  };

  /**
   * Rank lodging by average distance to all places (primary) with a small
   * nudge for stars / well-documented entries. Returns sorted copies with
   * avgDistance, maxDistance, distances[].
   */
  function rankHotels(hotels, places, { minStars = 0 } = {}) {
    const out = [];
    const seen = new Set();
    for (const h of hotels) {
      if (!h || seen.has(h.id)) continue;
      seen.add(h.id);
      const stars = parseFloat(h.tags.stars) || 0;
      if (minStars && stars && stars < minStars) continue;
      if (minStars && !stars) continue;
      const distances = places.map((p) => haversine(h, p));
      const avgDistance = distances.reduce((s, d) => s + d, 0) / distances.length;
      const maxDistance = Math.max(...distances);
      // Up to ~8% better effective distance for richer / higher-rated listings.
      const bonus = Math.min(0.08, stars * 0.01 + (h.tags.website ? 0.02 : 0) + (h.tags.wikidata ? 0.02 : 0));
      out.push({ ...h, stars, distances, avgDistance, maxDistance, score: avgDistance * (1 - bonus) });
    }
    out.sort((a, b) => a.score - b.score);
    return out;
  }

  /** Search radius around the median that should contain good candidates. */
  function hotelSearchRadius(center, places) {
    const spread = places.length ? Math.max(...places.map((p) => haversine(center, p))) : 0;
    return Math.round(Math.min(15000, Math.max(800, spread * 0.5)));
  }

  // ---------------------------------------------------------------------------
  // Importing saved places (Google Takeout CSV / JSON, My Maps KML, pasted links)
  // Every parser returns [{name, address?, lat?, lon?, note?, url?}]; entries
  // without coordinates are geocoded later by name.
  // ---------------------------------------------------------------------------

  const validCoord = (lat, lon) =>
    Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0);

  /** Extract coordinates and a name from any Google Maps URL that carries them. */
  function parseMapsUrl(raw) {
    let url = String(raw || '').trim();
    if (!url) return null;
    try { url = decodeURIComponent(url.replace(/\+/g, ' ')); } catch { /* keep as is */ }
    const out = { url: String(raw).trim() };

    const pin = /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/.exec(url);           // exact place pin
    const q = /[?&](?:q|query|ll|destination|center)=(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/.exec(url);
    const search = /\/maps\/search\/(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/.exec(url);
    const at = /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/.exec(url);                 // viewport centre
    const m = pin || q || search || at;
    if (m) {
      const lat = parseFloat(m[1]), lon = parseFloat(m[2]);
      if (validCoord(lat, lon)) { out.lat = lat; out.lon = lon; }
    }

    const place = /\/maps\/place\/([^/@?]+)/.exec(url);
    const qName = /[?&](?:q|query)=([^&]+)/.exec(url);
    let name = place ? place[1] : (qName && !q ? qName[1] : '');
    name = name.replace(/\s+/g, ' ').trim();
    if (name && !/^-?\d+(\.\d+)?,\s*-?\d+(\.\d+)?$/.test(name)) out.name = name;
    return out.name || out.lat !== undefined ? out : null;
  }

  /** RFC 4180-ish CSV parser (quoted fields, escaped quotes, newlines in quotes). */
  function parseCsv(text) {
    const rows = [];
    let row = [], field = '', inQuotes = false;
    const s = String(text).replace(/^﻿/, '');
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (inQuotes) {
        if (c === '"' && s[i + 1] === '"') { field += '"'; i++; }
        else if (c === '"') inQuotes = false;
        else field += c;
      } else if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && s[i + 1] === '\n') i++;
        row.push(field); rows.push(row); row = []; field = '';
      } else field += c;
    }
    if (field || row.length) { row.push(field); rows.push(row); }
    return rows.filter((r) => r.some((f) => f.trim() !== ''));
  }

  /** Google Takeout "Saved" list CSV (Title, Note, URL, Tags, Comment) or any CSV with name/lat/lon columns. */
  function parseSavedCsv(text) {
    const rows = parseCsv(text);
    if (!rows.length) return [];
    const header = rows[0].map((h) => h.trim().toLowerCase());
    const col = (...names) => header.findIndex((h) => names.includes(h));
    const iName = col('title', 'name', 'place', 'place name');
    const iUrl = col('url', 'google maps url', 'link');
    const iNote = col('note', 'notes', 'comment', 'description');
    const iAddr = col('address', 'location');
    const iLat = col('lat', 'latitude');
    const iLon = col('lon', 'lng', 'long', 'longitude');
    const hasHeader = iName >= 0 || iUrl >= 0;
    const body = hasHeader ? rows.slice(1) : rows;

    const out = [];
    for (const r of body) {
      const get = (i) => (i >= 0 && r[i] !== undefined ? r[i].trim() : '');
      const fromUrl = parseMapsUrl(hasHeader ? get(iUrl) : r.find((f) => /^https?:\/\//.test(f.trim())) || '') || {};
      const item = {
        name: get(iName) || fromUrl.name || (!hasHeader ? (r[0] || '').trim() : ''),
        address: get(iAddr) || undefined,
        note: get(iNote) || undefined,
        url: fromUrl.url,
      };
      const lat = parseFloat(get(iLat)), lon = parseFloat(get(iLon));
      if (validCoord(lat, lon)) { item.lat = lat; item.lon = lon; }
      else if (fromUrl.lat !== undefined) { item.lat = fromUrl.lat; item.lon = fromUrl.lon; }
      if (item.name || item.lat !== undefined) out.push(item);
    }
    return out;
  }

  /** Google Takeout "Saved Places.json" (old and new shapes) or any GeoJSON of points. */
  function parseSavedGeoJson(json) {
    const data = typeof json === 'string' ? JSON.parse(json) : json;
    const features = Array.isArray(data) ? data : data.features || [];
    const out = [];
    for (const f of features) {
      const p = f.properties || {};
      const loc = p.location || p.Location || {};
      const geo = loc['Geo Coordinates'] || {};
      const url = p.google_maps_url || p['Google Maps URL'] || p.url || '';
      const fromUrl = parseMapsUrl(url) || {};
      const item = {
        name: loc.name || loc['Business Name'] || p.Title || p.title || p.name || p.Name || fromUrl.name || '',
        address: loc.address || loc.Address || p.address || undefined,
        note: p.Comment || p.comment || p.description || undefined,
        url: url || undefined,
      };
      const c = f.geometry && f.geometry.type === 'Point' ? f.geometry.coordinates : null;
      const cand = [
        c ? [parseFloat(c[1]), parseFloat(c[0])] : null,
        [parseFloat(geo.Latitude), parseFloat(geo.Longitude)],
        [fromUrl.lat, fromUrl.lon],
      ];
      const hit = cand.find((x) => x && validCoord(x[0], x[1]));
      if (hit) { item.lat = hit[0]; item.lon = hit[1]; }
      if (!item.name && item.address) item.name = item.address.split(',')[0];
      if (item.name || item.lat !== undefined) out.push(item);
    }
    return out;
  }

  /** KML from Google My Maps / Google Earth: every Placemark with a Point. */
  function parseKml(text) {
    const out = [];
    const decode = (s) => String(s || '')
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ').trim();
    const tag = (block, t) => { const m = new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`, 'i').exec(block); return m ? m[1] : ''; };
    for (const m of String(text).matchAll(/<Placemark[\s\S]*?<\/Placemark>/gi)) {
      const block = m[0];
      const point = tag(block, 'Point');
      const coords = tag(point || block, 'coordinates').trim().split(/\s+/)[0] || '';
      const [lon, lat] = coords.split(',').map(parseFloat);
      const item = { name: decode(tag(block, 'name')), address: decode(tag(block, 'address')) || undefined, note: decode(tag(block, 'description')).slice(0, 300) || undefined };
      if (point && validCoord(lat, lon)) { item.lat = lat; item.lon = lon; }
      else if (!point) continue; // lines / polygons are not places
      if (item.name || item.lat !== undefined) out.push(item);
    }
    return out;
  }

  /** Free text: one Google Maps link, "lat, lon", or place name per line. */
  function parsePastedList(text) {
    const out = [];
    for (let line of String(text || '').split(/\r?\n/)) {
      line = line.replace(/^\s*(?:[-*•]\s*|\d+[.)]\s+)/, '').trim();
      if (!line) continue;
      const urlMatch = /https?:\/\/\S+/.exec(line);
      if (urlMatch) {
        const u = parseMapsUrl(urlMatch[0]);
        const label = line.replace(urlMatch[0], '').replace(/[-–:|]\s*$/, '').trim();
        if (u && (u.name || u.lat !== undefined)) out.push({ ...u, name: label || u.name || '' });
        else out.push({ name: label, url: urlMatch[0], unresolved: !label });
        continue;
      }
      const ll = /^(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)$/.exec(line);
      if (ll && validCoord(+ll[1], +ll[2])) { out.push({ name: '', lat: +ll[1], lon: +ll[2] }); continue; }
      out.push({ name: line });
    }
    return out;
  }

  /** Pick the right parser from the file name / content. */
  function parseImportFile(fileName, text) {
    const n = String(fileName || '').toLowerCase();
    const t = String(text || '').trim();
    if (n.endsWith('.kml') || /^<\?xml|<kml[\s>]/i.test(t)) return parseKml(t);
    if (n.endsWith('.json') || n.endsWith('.geojson') || /^[{[]/.test(t)) return parseSavedGeoJson(t);
    if (n.endsWith('.csv') || /^(title|name)\s*,/i.test(t)) return parseSavedCsv(t);
    return parsePastedList(t);
  }

  const Core = {
    haversine, averageDistance, geometricMedian, formatDistance, walkingMinutes,
    STYLES, KEYWORDS, parseDescription, buildOverpassQuery, filtersFor, classify,
    toPoi, notability, rankPois, LODGING, rankHotels, hotelSearchRadius, escapeRegex,
    parseMapsUrl, parseCsv, parseSavedCsv, parseSavedGeoJson, parseKml, parsePastedList, parseImportFile,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Core;
  else root.Core = Core;
})(typeof window !== 'undefined' ? window : globalThis);
