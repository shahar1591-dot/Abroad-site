/*
 * Network access: OpenStreetMap Nominatim (geocoding), Overpass (POIs),
 * browser geolocation with IP fallback. All free, keyless, worldwide.
 */
(function (root) {
  'use strict';

  const NOMINATIM = 'https://nominatim.openstreetmap.org';
  const OVERPASS_ENDPOINTS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  ];

  const lang = () => (navigator.languages && navigator.languages.join(',')) || navigator.language || 'en';

  // Nominatim asks for at most one request per second.
  let lastNominatim = 0;
  async function nominatim(path, params, signal) {
    const wait = lastNominatim + 1000 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastNominatim = Date.now();
    const url = `${NOMINATIM}/${path}?${new URLSearchParams({ format: 'jsonv2', 'accept-language': lang(), ...params })}`;
    const res = await fetch(url, { signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`Geocoding failed (${res.status})`);
    return res.json();
  }

  async function searchPlaces(query, { near, signal } = {}) {
    const params = { q: query, limit: '8', addressdetails: '1' };
    if (near) {
      // Bias (not restrict) results toward the current map view.
      const d = 2;
      params.viewbox = [near.lon - d, near.lat + d, near.lon + d, near.lat - d].join(',');
    }
    const rows = await nominatim('search', params, signal);
    return rows.map((r) => ({
      name: r.name || r.display_name.split(',')[0],
      address: r.display_name,
      lat: parseFloat(r.lat),
      lon: parseFloat(r.lon),
      kind: r.type,
      osm: r.osm_type && r.osm_id ? `${r.osm_type}/${r.osm_id}` : null,
    }));
  }

  async function reverseGeocode(lat, lon, zoom = 18) {
    const r = await nominatim('reverse', { lat, lon, zoom: String(zoom), addressdetails: '1' });
    if (!r || r.error) return null;
    const a = r.address || {};
    return {
      name: r.name || a.attraction || a.tourism || a.road || a.suburb || a.city || r.display_name.split(',')[0],
      address: r.display_name,
      city: a.city || a.town || a.village || a.municipality || a.county || a.state || '',
      country: a.country || '',
      lat: parseFloat(r.lat),
      lon: parseFloat(r.lon),
    };
  }

  let preferredEndpoint = 0;
  async function overpass(query, { signal } = {}) {
    let lastError;
    for (let i = 0; i < OVERPASS_ENDPOINTS.length; i++) {
      const idx = (preferredEndpoint + i) % OVERPASS_ENDPOINTS.length;
      try {
        const res = await fetch(OVERPASS_ENDPOINTS[idx], {
          method: 'POST',
          body: new URLSearchParams({ data: query }),
          signal,
        });
        if (res.status === 429 || res.status >= 500) throw new Error(`Map data server busy (${res.status})`);
        if (!res.ok) throw new Error(`Map data query failed (${res.status})`);
        const json = await res.json();
        if (json.remark && /runtime error|timed out/i.test(json.remark) && !json.elements?.length) {
          throw new Error('Map data query timed out');
        }
        preferredEndpoint = idx;
        return json.elements || [];
      } catch (err) {
        if (err.name === 'AbortError') throw err;
        lastError = err;
      }
    }
    throw lastError || new Error('Map data unavailable');
  }

  /** Resolve the user's location: precise GPS first, then approximate IP lookup. */
  function locate({ timeout = 12000 } = {}) {
    return new Promise((resolve, reject) => {
      const fallback = async (reason) => {
        try {
          const res = await fetch('https://ipapi.co/json/');
          if (!res.ok) throw new Error();
          const j = await res.json();
          if (typeof j.latitude !== 'number') throw new Error();
          resolve({ lat: j.latitude, lon: j.longitude, accuracy: 25000, approximate: true, label: [j.city, j.country_name].filter(Boolean).join(', ') });
        } catch {
          reject(new Error(reason || 'Could not determine your location'));
        }
      };
      if (!('geolocation' in navigator)) return fallback('Geolocation not supported');
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: pos.coords.accuracy, approximate: false }),
        (err) => fallback(err.code === 1 ? 'Location permission denied' : 'Location unavailable'),
        { enableHighAccuracy: true, timeout, maximumAge: 60000 }
      );
    });
  }

  root.Api = { searchPlaces, reverseGeocode, overpass, locate };
})(window);
