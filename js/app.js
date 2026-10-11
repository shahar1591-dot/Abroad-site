/* Abroad — UI and map wiring. Depends on Leaflet, Core (core.js) and Api (api.js). */
(function () {
  'use strict';

  const { STYLES, LODGING } = Core;
  const STORAGE_KEY = 'abroad.v1';
  const DEFAULT_STYLES = ['landmarks', 'museums', 'history', 'viewpoints'];
  const $ = (sel) => document.querySelector(sel);

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  const state = {
    places: [],               // {id, name, address, lat, lon, osm?}
    styles: new Set(),
    text: '',
    radius: 1500,
    lodging: new Set(['hotel', 'guest_house', 'apartment']),
    minStars: 0,
    me: null,                 // {lat, lon, accuracy, approximate, label}
    attractions: [],
    hotels: [],
  };

  function load() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (!raw) return;
      if (Array.isArray(raw.places)) state.places = raw.places.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
      if (Array.isArray(raw.styles)) state.styles = new Set(raw.styles.filter((s) => STYLES[s]));
      if (typeof raw.text === 'string') state.text = raw.text;
      if (Number.isFinite(raw.radius)) state.radius = raw.radius;
      if (Array.isArray(raw.lodging) && raw.lodging.length) state.lodging = new Set(raw.lodging.filter((s) => LODGING[s]));
      if (Number.isFinite(raw.minStars)) state.minStars = raw.minStars;
    } catch { /* storage unavailable or corrupt: start fresh */ }
  }
  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        places: state.places, styles: [...state.styles], text: state.text,
        radius: state.radius, lodging: [...state.lodging], minStars: state.minStars,
      }));
    } catch { /* ignore */ }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = () => Math.random().toString(36).slice(2, 10);
  const fmt = Core.formatDistance;

  function toast(msg, type = 'info', ms = 3800) {
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = msg;
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), ms);
  }

  async function withLoading(btn, fn) {
    if (btn.classList.contains('loading')) return;
    btn.classList.add('loading');
    btn.disabled = true;
    try { return await fn(); }
    catch (err) {
      console.error(err);
      toast(err.message || 'Something went wrong', 'error', 5000);
    } finally {
      btn.classList.remove('loading');
      btn.disabled = false;
    }
  }

  function wikipediaUrl(tag) {
    if (!tag) return null;
    const m = /^([a-z-]+):(.+)$/.exec(tag);
    if (!m) return null;
    return `https://${m[1]}.wikipedia.org/wiki/${encodeURIComponent(m[2].replace(/ /g, '_'))}`;
  }
  const gmapsUrl = (name, lat, lon) =>
    `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(name ? `${name}` : `${lat},${lon}`)}${name ? `&center=${lat},${lon}` : ''}`;
  const gmapsCoords = (lat, lon) => `https://www.google.com/maps/search/?api=1&query=${lat.toFixed(6)},${lon.toFixed(6)}`;
  const osmUrl = (p) => (p.osmType ? `https://www.openstreetmap.org/${p.osmType}/${p.osmId}` : `https://www.openstreetmap.org/?mlat=${p.lat}&mlon=${p.lon}#map=18/${p.lat}/${p.lon}`);

  function prettyTag(v) {
    return String(v).replace(/_/g, ' ').replace(/;/g, ', ');
  }

  // ---------------------------------------------------------------------------
  // Map
  // ---------------------------------------------------------------------------
  const map = L.map('map', { worldCopyJump: true, zoomControl: false }).setView([25, 10], 2);
  L.control.zoom({ position: 'topright' }).addTo(map);

  // Keyless tile servers only (CARTO basemaps now watermark tiles without an API key).
  const osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  });
  const topo = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
    maxZoom: 17, subdomains: 'abc',
    attribution: 'Map data &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, SRTM | Style &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)',
  });
  osm.addTo(map);

  const layers = {
    lines: L.layerGroup().addTo(map),
    attractions: L.layerGroup().addTo(map),
    near: L.layerGroup().addTo(map),
    hotels: L.layerGroup().addTo(map),
    places: L.layerGroup().addTo(map),
    me: L.layerGroup().addTo(map),
  };
  L.control.layers(
    { 'Streets': osm, 'Terrain': topo },
    {
      'My places': layers.places, 'Suggested attractions': layers.attractions,
      'Near me': layers.near, 'Stays': layers.hotels, 'Distance lines': layers.lines, 'My location': layers.me,
    },
    { position: 'topright', collapsed: true }
  ).addTo(map);
  L.control.scale({ position: 'bottomright', imperial: false }).addTo(map);

  const icons = {
    place: (n) => L.divIcon({ className: 'mk', html: `<div class="mk-pin"><span>${n}</span></div>`, iconSize: [30, 30], iconAnchor: [15, 34], popupAnchor: [0, -30] }),
    poi: (style) => {
      const s = STYLES[style] || STYLES.landmarks;
      return L.divIcon({ className: 'mk', html: `<div class="mk-poi" style="border-color:${s.color}">${s.icon}</div>`, iconSize: [30, 30], iconAnchor: [15, 15], popupAnchor: [0, -14] });
    },
    hotel: (best) => L.divIcon({ className: 'mk', html: `<div class="mk-hotel${best ? ' best' : ''}">🏨</div>`, iconSize: best ? [42, 42] : [32, 32], iconAnchor: best ? [21, 21] : [16, 16], popupAnchor: [0, -16] }),
    center: L.divIcon({ className: 'mk', html: '<div class="mk-center"></div>', iconSize: [16, 16], iconAnchor: [8, 8] }),
    me: L.divIcon({ className: 'mk', html: '<div class="mk-me"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }),
  };

  // Popup buttons are wired through delegation: <button data-act="..." data-key="...">
  const popupActions = new Map();
  function registerAction(fn) { const k = uid(); popupActions.set(k, fn); return k; }
  map.getContainer().addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act-key]');
    if (!btn) return;
    e.preventDefault();
    const fn = popupActions.get(btn.dataset.actKey);
    if (fn) fn(btn);
  });

  function poiPopup(p, { addable = true } = {}) {
    const t = p.tags || {};
    const s = STYLES[p.style] || STYLES.landmarks;
    const details = [];
    if (t.cuisine) details.push(`Cuisine: ${prettyTag(t.cuisine)}`);
    if (t.opening_hours) details.push(`Hours: ${esc(t.opening_hours)}`);
    if (t.fee) details.push(`Fee: ${esc(t.fee)}`);
    const desc = t['description:en'] || t.description;
    const links = [];
    const wp = wikipediaUrl(t.wikipedia);
    if (wp) links.push(`<a href="${esc(wp)}" target="_blank" rel="noopener">Wikipedia</a>`);
    const site = t.website || t['contact:website'];
    if (site && /^https?:\/\//i.test(site)) links.push(`<a href="${esc(site)}" target="_blank" rel="noopener">Website</a>`);
    links.push(`<a href="${esc(gmapsCoords(p.lat, p.lon))}" target="_blank" rel="noopener">Google Maps</a>`);
    links.push(`<a href="${esc(osmUrl(p))}" target="_blank" rel="noopener">OSM</a>`);
    const already = state.places.some((x) => x.osm === p.id);
    const addBtn = addable && !already
      ? `<button class="main" data-act-key="${registerAction(() => { addPlace({ name: p.name, address: describeAddress(t) || s.label, lat: p.lat, lon: p.lon, osm: p.id }); map.closePopup(); })}">+ Add to my places</button>`
      : '';
    const near = p.near ? `<div class="sub">${fmt(p.distance)} from ${esc(p.near.name)} · ~${Core.walkingMinutes(p.distance)} min walk</div>` : '';
    return `<div class="pop">
      <h3>${s.icon} ${esc(p.name)}</h3>
      <div class="sub">${esc(s.label)}${t.name && t.name !== p.name ? ` · ${esc(t.name)}` : ''}</div>
      ${near}
      ${desc ? `<div>${esc(desc).slice(0, 220)}</div>` : ''}
      ${details.length ? `<div class="sub">${details.map(esc).join('<br>')}</div>` : ''}
      <div class="actions">${addBtn}${links.join('')}</div>
    </div>`;
  }

  function describeAddress(t) {
    const street = [t['addr:street'], t['addr:housenumber']].filter(Boolean).join(' ');
    return [street, t['addr:city']].filter(Boolean).join(', ');
  }

  // Click on map -> offer to add the spot.
  map.on('click', async (e) => {
    const { lat, lng } = e.latlng;
    const popup = L.popup().setLatLng(e.latlng).setContent('<div class="pop"><div class="sub">Looking up this spot…</div></div>').openOn(map);
    let info = null;
    try { info = await Api.reverseGeocode(lat, L.Util.wrapNum(lng, [-180, 180], true)); } catch { /* offline etc. */ }
    if (!map.hasLayer(popup)) return;
    const name = info?.name || `Pinned spot (${lat.toFixed(4)}, ${lng.toFixed(4)})`;
    const address = info?.address || '';
    const key = registerAction(() => { addPlace({ name, address, lat, lon: L.Util.wrapNum(lng, [-180, 180], true) }); map.closePopup(); });
    popup.setContent(`<div class="pop"><h3>${esc(name)}</h3><div class="sub">${esc(address)}</div>
      <div class="actions"><button class="main" data-act-key="${key}">+ Add to my places</button>
      <a href="${esc(gmapsCoords(lat, lng))}" target="_blank" rel="noopener">Google Maps</a></div></div>`);
  });

  function fitAll() {
    const pts = [
      ...state.places.map((p) => [p.lat, p.lon]),
      ...state.attractions.map((p) => [p.lat, p.lon]),
      ...state.hotels.slice(0, 8).map((p) => [p.lat, p.lon]),
    ];
    if (!pts.length && state.me) pts.push([state.me.lat, state.me.lon]);
    if (!pts.length) return;
    if (pts.length === 1) map.flyTo(pts[0], 15);
    else map.flyToBounds(L.latLngBounds(pts).pad(0.15), { maxZoom: 16, duration: 0.8 });
  }

  // ---------------------------------------------------------------------------
  // Places
  // ---------------------------------------------------------------------------
  function addPlace(p) {
    const dupe = state.places.find((x) => (p.osm && x.osm === p.osm) || (Core.haversine(x, p) < 25 && x.name === p.name));
    if (dupe) { toast(`"${p.name}" is already on your list`); return; }
    state.places.push({ id: uid(), name: p.name, address: p.address || '', lat: p.lat, lon: p.lon, osm: p.osm || null });
    save();
    renderPlaces();
    invalidateHotels();
    toast(`Added "${p.name}"`);
    if (state.places.length === 1) map.flyTo([p.lat, p.lon], 15, { duration: 0.8 });
    else fitAll();
  }

  /** Add many places at once (imports): one render, one toast. Returns how many were new. */
  function addPlaces(list) {
    let added = 0;
    for (const p of list) {
      const dupe = state.places.find((x) => (p.osm && x.osm === p.osm) || (Core.haversine(x, p) < 25 && x.name === p.name));
      if (dupe) continue;
      state.places.push({ id: uid(), name: p.name, address: p.address || '', lat: p.lat, lon: p.lon, osm: p.osm || null, list: p.list || null });
      added++;
    }
    if (!added) return 0;
    save();
    renderPlaces();
    invalidateHotels();
    fitAll();
    return added;
  }

  function removePlace(id) {
    state.places = state.places.filter((p) => p.id !== id);
    save();
    renderPlaces();
    invalidateHotels();
  }

  function invalidateHotels() {
    if (!state.hotels.length) return;
    state.hotels = [];
    layers.hotels.clearLayers();
    layers.lines.clearLayers();
    $('#hotel-results').innerHTML = '<div class="empty-state">Your list changed — run the search again to update the best stay.</div>';
  }

  function renderPlaces() {
    const list = $('#place-list');
    list.innerHTML = '';
    layers.places.clearLayers();
    state.places.forEach((p, i) => {
      const li = document.createElement('li');
      li.className = 'place-item';
      li.innerHTML = `<span class="pin-num">${i + 1}</span>
        <div class="meta"><div class="name">${esc(p.name)}</div><div class="addr">${p.list ? `<span class="from">📁 ${esc(p.list)}</span> ` : ''}${esc(p.address)}</div></div>
        <button class="icon-btn" title="Remove" aria-label="Remove ${esc(p.name)}">✕</button>`;
      li.addEventListener('click', (e) => {
        if (e.target.closest('.icon-btn')) { removePlace(p.id); return; }
        map.flyTo([p.lat, p.lon], Math.max(map.getZoom(), 15), { duration: 0.6 });
        marker.openPopup();
        sheet('normal');
      });
      list.appendChild(li);

      const marker = L.marker([p.lat, p.lon], { icon: icons.place(i + 1), zIndexOffset: 1000, title: p.name }).addTo(layers.places);
      const removeKey = registerAction(() => { removePlace(p.id); map.closePopup(); });
      marker.bindPopup(`<div class="pop"><h3>${i + 1}. ${esc(p.name)}</h3><div class="sub">${esc(p.address)}</div>
        <div class="actions"><a href="${esc(gmapsCoords(p.lat, p.lon))}" target="_blank" rel="noopener">Google Maps</a>
        <button data-act-key="${removeKey}">Remove</button></div></div>`);
    });
    $('#place-actions').hidden = state.places.length === 0;
    renderImportedLists();
  }

  /** Chips for every Google Maps list the current places came from, each removable as a whole. */
  function renderImportedLists() {
    const box = $('#imported-lists');
    const counts = new Map();
    for (const p of state.places) if (p.list) counts.set(p.list, (counts.get(p.list) || 0) + 1);
    box.hidden = counts.size === 0;
    box.innerHTML = counts.size ? '<span class="label">From Google Maps:</span>' : '';
    for (const [name, n] of counts) {
      const chip = document.createElement('span');
      chip.className = 'list-chip';
      chip.innerHTML = `📁 ${esc(name)} <b>${n}</b><button class="icon-btn" title="Remove this list's places" aria-label="Remove all places from ${esc(name)}">✕</button>`;
      chip.querySelector('button').addEventListener('click', () => {
        if (!confirm(`Remove the ${n} place${n === 1 ? '' : 's'} imported from "${name}"?`)) return;
        state.places = state.places.filter((p) => p.list !== name);
        save();
        renderPlaces();
        invalidateHotels();
      });
      box.appendChild(chip);
    }
  }

  // Search box with autocomplete
  (function setupSearch() {
    const input = $('#place-search');
    const list = $('#search-results');
    let timer = null, ctrl = null, items = [], active = -1;

    const close = () => { list.hidden = true; active = -1; };
    const highlight = (i) => {
      active = i;
      [...list.children].forEach((li, j) => li.setAttribute('aria-selected', String(j === i)));
    };
    const choose = (i) => {
      const r = items[i];
      if (!r) return;
      addPlace(r);
      input.value = '';
      close();
    };
    const render = () => {
      list.innerHTML = '';
      if (!items.length) {
        list.innerHTML = '<li class="empty">No matches — try adding the city or country.</li>';
      }
      items.forEach((r, i) => {
        const li = document.createElement('li');
        li.setAttribute('role', 'option');
        li.innerHTML = `<div class="title">${esc(r.name)}</div><div class="sub">${esc(r.address)}</div>`;
        li.addEventListener('mousedown', (e) => { e.preventDefault(); choose(i); });
        list.appendChild(li);
      });
      list.hidden = false;
    };
    const run = async () => {
      const q = input.value.trim();
      if (q.length < 2) { close(); return; }
      ctrl?.abort();
      ctrl = new AbortController();
      try {
        const c = map.getCenter();
        items = await Api.searchPlaces(q, { near: map.getZoom() >= 8 ? { lat: c.lat, lon: c.lng } : null, signal: ctrl.signal });
        if (input.value.trim() === q) { render(); highlight(items.length ? 0 : -1); }
      } catch (err) {
        if (err.name !== 'AbortError') toast(err.message || 'Search failed', 'error');
      }
    };
    input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 450); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' && items.length) { e.preventDefault(); highlight((active + 1) % items.length); }
      else if (e.key === 'ArrowUp' && items.length) { e.preventDefault(); highlight((active - 1 + items.length) % items.length); }
      else if (e.key === 'Enter') {
        e.preventDefault();
        if (!list.hidden && active >= 0) choose(active);
        else { clearTimeout(timer); run(); }
      } else if (e.key === 'Escape') close();
    });
    input.addEventListener('blur', () => setTimeout(close, 150));
    input.addEventListener('focus', () => { if (items.length && input.value.trim()) list.hidden = false; });
  })();

  // ---------------------------------------------------------------------------
  // Import from Google Maps (Takeout CSV / Saved Places.json / My Maps KML / pasted links)
  // ---------------------------------------------------------------------------
  (function setupImport() {
    const panel = $('#import-panel');
    const toggle = $('#import-toggle');
    const fileInput = $('#import-file');
    const drop = $('#file-drop');
    const preview = $('#import-preview');
    let items = [];
    let busy = false;

    try { $('#import-area').value = localStorage.getItem('abroad.importArea') || ''; } catch { /* ignore */ }

    toggle.addEventListener('click', () => {
      panel.hidden = !panel.hidden;
      toggle.setAttribute('aria-expanded', String(!panel.hidden));
      if (!panel.hidden) sheet('expanded');
    });

    ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, () => drop.classList.add('over')));
    ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, () => drop.classList.remove('over')));
    fileInput.addEventListener('change', () => { if (fileInput.files.length) read(); });
    $('#import-read').addEventListener('click', read);

    const PLACE_FILE = /\.(csv|json|geojson|kml)$/i;
    const SKIP_FILE = /(^|\/)(archive_browser|.*\.html?$)/i;

    /** Turn one chosen file (csv/json/kml or a Takeout .zip / My Maps .kmz) into [{list, items}]. */
    async function readFile(file) {
      const buf = new Uint8Array(await file.arrayBuffer());
      if (!Core.isZip(buf)) {
        const text = new TextDecoder('utf-8').decode(buf);
        return [{ list: Core.listNameFromPath(file.name), items: Core.parseImportFile(file.name, text) }];
      }
      const isKmz = /\.kmz$/i.test(file.name);
      const entries = await Core.readZip(buf, (path) => PLACE_FILE.test(path) && !SKIP_FILE.test(path));
      const out = [];
      for (const e of entries) {
        let parsed = [];
        try { parsed = Core.parseImportFile(e.path, e.text); } catch { /* not a places file */ }
        if (!parsed.length) continue;
        out.push({ list: isKmz ? Core.listNameFromPath(file.name) : Core.listNameFromPath(e.path), items: parsed });
      }
      return out;
    }

    const sameName = (a, b) => (a || '').trim().toLowerCase() === (b || '').trim().toLowerCase();
    function alreadyHave(it) {
      return state.places.some((p) => sameName(p.name, it.name) &&
        (it.lat === undefined ? (!it.source || p.list === it.source) : Core.haversine(p, it) < 150));
    }

    let readSeq = 0;
    async function read() {
      if (busy) return;
      const seq = ++readSeq; // a newer read (e.g. file picked, then button clicked) supersedes this one
      const found = [];
      const problems = [];
      const readBtn = $('#import-read');
      readBtn.classList.add('loading');
      try {
        for (const file of fileInput.files) {
          try {
            const lists = await readFile(file);
            const total = lists.reduce((n, l) => n + l.items.length, 0);
            if (!total) {
              problems.push(/\.(zip|kmz)$/i.test(file.name)
                ? `${file.name}: no saved places inside. In Takeout, make sure "Saved" or "Maps (your places)" is ticked.`
                : `${file.name}: no places found`);
            }
            for (const l of lists) l.items.forEach((it) => found.push({ ...it, source: l.list }));
          } catch (err) {
            console.error(err);
            problems.push(`${file.name}: ${err.message && /zip/i.test(err.message) ? err.message : 'could not read this file'}`);
          }
        }
      } finally {
        readBtn.classList.remove('loading');
      }
      if (seq !== readSeq) return;
      const pasted = $('#import-text').value;
      if (pasted.trim()) Core.parsePastedList(pasted).forEach((it) => found.push({ ...it, source: 'Pasted' }));

      if (!found.length) {
        preview.innerHTML = `<div class="empty-state">${problems.length ? problems.map(esc).join('<br>') : 'Choose a file or paste some links / names first.'}</div>`;
        return;
      }
      // De-duplicate within the import (the same place is often in several lists).
      const seen = new Set();
      items = found.filter((it) => {
        const key = it.lat !== undefined ? `${it.lat.toFixed(5)},${it.lon.toFixed(5)}` : `n:${(it.name || '').toLowerCase()}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }).map((it) => {
        const status = it.unresolved ? 'short' : alreadyHave(it) ? 'have' : it.lat !== undefined ? 'located' : 'lookup';
        return { ...it, status, checked: status === 'located' || status === 'lookup' };
      });
      // Many lists at once (a whole Takeout): start with nothing ticked so the user picks the trip's lists.
      const fileLists = new Set(items.map((it) => it.source).filter((l) => l !== 'Pasted'));
      if (fileLists.size > 1) {
        items.forEach((it) => { if (it.source !== 'Pasted') it.checked = false; });
      }
      renderPreview(problems);
    }

    const STATUS = {
      located: '📍 on map',
      lookup: '🔎 will look up',
      searching: '⏳ looking up…',
      found: '✅ found',
      notfound: '⚠️ not found',
      short: '⚠️ short link',
      added: '✔️ added',
      have: '✔️ already on map',
    };

    const ADDABLE = ['located', 'lookup', 'found'];
    const selectable = (it) => ADDABLE.includes(it.status);

    function renderPreview(problems = []) {
      preview.innerHTML = '';
      const groups = new Map();
      for (const it of items) {
        if (!groups.has(it.source)) groups.set(it.source, []);
        groups.get(it.source).push(it);
      }

      const bar = document.createElement('div');
      bar.className = 'import-bar';
      bar.innerHTML = `<span>${items.length} place${items.length === 1 ? '' : 's'}${groups.size > 1 ? ` in ${groups.size} lists` : ''}${groups.size > 1 ? ' — tick the lists for this trip' : ''}</span>
        <span><button class="btn ghost small" data-all="1">All</button> <button class="btn ghost small" data-all="0">None</button></span>`;
      bar.addEventListener('click', (e) => {
        const b = e.target.closest('[data-all]');
        if (!b || busy) return;
        items.filter(selectable).forEach((it) => { it.checked = b.dataset.all === '1'; });
        renderPreview(problems);
      });
      preview.appendChild(bar);
      if (problems.length) {
        const warn = document.createElement('div');
        warn.className = 'empty-state';
        warn.innerHTML = problems.map(esc).join('<br>');
        preview.appendChild(warn);
      }

      const list = document.createElement('div');
      list.className = 'import-list';
      for (const [name, group] of groups) {
        const box = document.createElement('details');
        box.className = 'import-group';
        box.open = groups.size === 1 || group.length <= 8;
        const pick = group.filter(selectable);
        const on = pick.filter((it) => it.checked).length;
        const have = group.filter((it) => it.status === 'have' || it.status === 'added').length;
        box.innerHTML = `<summary><input type="checkbox" aria-label="Select list ${esc(name)}" ${pick.length ? '' : 'disabled'}>
          <span class="gname">${name === 'Pasted' ? '📋 Pasted' : `📁 ${esc(name)}`}</span>
          <span class="gcount">${group.length}${have ? ` · ${have} on map` : ''}</span></summary>`;
        const groupBox = box.querySelector('summary input');
        groupBox.checked = pick.length > 0 && on === pick.length;
        groupBox.indeterminate = on > 0 && on < pick.length;
        groupBox.addEventListener('click', (e) => e.stopPropagation());
        groupBox.addEventListener('change', () => {
          if (busy) return;
          pick.forEach((it) => { it.checked = groupBox.checked; });
          renderPreview(problems);
        });

        for (const it of group) {
          const row = document.createElement('label');
          const disabled = !selectable(it) || busy;
          row.className = `import-row${it.status === 'short' || it.status === 'notfound' ? ' bad' : ''}`;
          const sub = it.status === 'short'
            ? 'Short share links can’t be read here — open it in your browser and paste the full address instead.'
            : [it.address, it.note].filter(Boolean).join(' · ');
          row.innerHTML = `<input type="checkbox" ${it.checked && !disabled ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
            <div class="meta"><div class="name">${esc(it.name || it.url || (it.lat !== undefined ? `${it.lat.toFixed(5)}, ${it.lon.toFixed(5)}` : 'Unnamed place'))}</div>
            ${sub ? `<div class="sub">${esc(sub).slice(0, 220)}</div>` : ''}</div>
            <span class="status">${STATUS[it.status]}</span>`;
          row.querySelector('input').addEventListener('change', (e) => {
            it.checked = e.target.checked;
            const n = pick.filter((x) => x.checked).length;
            groupBox.checked = n === pick.length;
            groupBox.indeterminate = n > 0 && n < pick.length;
            updateButton();
          });
          it.row = row;
          box.appendChild(row);
        }
        list.appendChild(box);
      }
      preview.appendChild(list);

      const btn = document.createElement('button');
      btn.className = 'btn primary block';
      btn.id = 'import-add';
      btn.addEventListener('click', () => addSelected(btn));
      preview.appendChild(btn);
      updateButton();
    }

    function updateButton() {
      const btn = $('#import-add');
      if (!btn) return;
      const n = items.filter((it) => it.checked && selectable(it)).length;
      btn.textContent = n ? `Add ${n} place${n === 1 ? '' : 's'} to my map` : 'Nothing selected';
      btn.disabled = !n || busy;
    }

    async function addSelected(btn) {
      const chosen = items.filter((it) => it.checked && selectable(it));
      if (!chosen.length || busy) return;
      busy = true;
      btn.disabled = true;
      const area = $('#import-area').value.trim();
      try { localStorage.setItem('abroad.importArea', area); } catch { /* ignore */ }
      // Bias name lookups toward places we already know about.
      const known = [...state.places, ...items.filter((it) => it.lat !== undefined)];
      const near = known.length ? Core.geometricMedian(known) : null;

      const toFind = chosen.filter((it) => it.lat === undefined || !it.name);
      let done = 0;
      for (const it of toFind) {
        btn.textContent = `Looking up ${++done} of ${toFind.length}…`;
        it.status = 'searching';
        renderRowsOnly();
        try {
          if (it.lat === undefined) {
            const q = [it.address || it.name, !it.address && area ? area : ''].filter(Boolean).join(', ');
            const res = await Api.searchPlaces(q, { near: area ? null : near });
            if (res.length) {
              it.lat = res[0].lat; it.lon = res[0].lon;
              it.address = it.address || res[0].address;
              it.name = it.name || res[0].name;
              it.status = 'found';
            } else {
              it.status = 'notfound';
              it.checked = false;
            }
          } else {
            const info = await Api.reverseGeocode(it.lat, it.lon);
            it.name = info?.name || `Pinned spot (${it.lat.toFixed(4)}, ${it.lon.toFixed(4)})`;
            it.address = it.address || info?.address || '';
            it.status = 'found';
          }
        } catch (err) {
          console.error(err);
          if (it.lat === undefined) { it.status = 'notfound'; it.checked = false; }
          else { it.name = it.name || `Pinned spot (${it.lat.toFixed(4)}, ${it.lon.toFixed(4)})`; it.status = 'found'; }
        }
      }

      const ready = chosen.filter((it) => it.lat !== undefined && it.status !== 'notfound');
      const added = addPlaces(ready.map((it) => ({ name: it.name, address: it.address || '', lat: it.lat, lon: it.lon, list: it.source !== 'Pasted' ? it.source : null })));
      ready.forEach((it) => { it.status = 'added'; it.checked = false; });
      busy = false;
      const missing = chosen.length - ready.length;
      toast(`Imported ${added} place${added === 1 ? '' : 's'}${ready.length - added ? ` (${ready.length - added} already on your list)` : ''}${missing ? ` · ${missing} not found` : ''}`);
      renderPreview();
    }

    function renderRowsOnly() {
      items.forEach((it) => { const el = it.row?.querySelector('.status'); if (el) el.textContent = STATUS[it.status]; });
    }
  })();

  // ---------------------------------------------------------------------------
  // Styles
  // ---------------------------------------------------------------------------
  function renderChips() {
    const box = $('#style-chips');
    box.innerHTML = '';
    for (const [key, s] of Object.entries(STYLES)) {
      const b = document.createElement('button');
      b.className = 'chip';
      b.type = 'button';
      b.textContent = `${s.icon} ${s.label}`;
      b.setAttribute('aria-pressed', String(state.styles.has(key)));
      b.addEventListener('click', () => {
        state.styles.has(key) ? state.styles.delete(key) : state.styles.add(key);
        b.setAttribute('aria-pressed', String(state.styles.has(key)));
        save();
      });
      box.appendChild(b);
    }

    const lbox = $('#lodging-chips');
    lbox.innerHTML = '';
    for (const [key, l] of Object.entries(LODGING)) {
      const b = document.createElement('button');
      b.className = 'chip';
      b.type = 'button';
      b.textContent = l.label;
      b.setAttribute('aria-pressed', String(state.lodging.has(key)));
      b.addEventListener('click', () => {
        if (state.lodging.has(key) && state.lodging.size === 1) { toast('Keep at least one type of stay'); return; }
        state.lodging.has(key) ? state.lodging.delete(key) : state.lodging.add(key);
        b.setAttribute('aria-pressed', String(state.lodging.has(key)));
        save();
      });
      lbox.appendChild(b);
    }
  }

  function updateDetected() {
    const { styles, extra } = Core.parseDescription(state.text);
    const parts = [];
    if (styles.length) parts.push(`Understood: <b>${styles.map((s) => `${STYLES[s].icon} ${esc(STYLES[s].label)}`).join(', ')}</b>`);
    if (extra.length) parts.push(`Also searching for: <b>${extra.map(esc).join(', ')}</b>`);
    $('#style-detected').innerHTML = parts.join('<br>');
  }

  function activeStyles() {
    const parsed = Core.parseDescription(state.text);
    const styles = new Set([...state.styles, ...parsed.styles]);
    const usedDefault = styles.size === 0 && parsed.extra.length === 0;
    return { styles: usedDefault ? DEFAULT_STYLES : [...styles], extra: parsed.extra, usedDefault };
  }

  // ---------------------------------------------------------------------------
  // Attractions
  // ---------------------------------------------------------------------------
  async function queryPois(filters, centers, radius) {
    const out = [];
    const CHUNK = 8; // keep each Overpass request a reasonable size
    for (let i = 0; i < centers.length; i += CHUNK) {
      const q = Core.buildOverpassQuery(filters, centers.slice(i, i + CHUNK), radius);
      const els = await Api.overpass(q);
      for (const el of els) { const p = Core.toPoi(el); if (p) out.push(p); }
    }
    return out;
  }

  function resultRow(p, { onAdd, extraSub = '' } = {}) {
    const s = STYLES[p.style] || STYLES.landmarks;
    const div = document.createElement('div');
    div.className = 'result';
    const already = state.places.some((x) => x.osm === p.id);
    div.innerHTML = `<span class="emoji">${s.icon}</span>
      <div class="meta"><div class="name">${esc(p.name)}</div>
      <div class="sub">${esc(s.label)} · ${fmt(p.distance)}${p.near?.name ? ` from ${esc(p.near.name)}` : ''} · ~${Core.walkingMinutes(p.distance)} min walk${extraSub}</div></div>
      ${onAdd && !already ? '<button class="icon-btn" title="Add to my places" aria-label="Add to my places">＋</button>' : ''}`;
    div.addEventListener('click', (e) => {
      if (e.target.closest('.icon-btn')) { onAdd(p); e.target.closest('.icon-btn').remove(); return; }
      map.flyTo([p.lat, p.lon], Math.max(map.getZoom(), 16), { duration: 0.6 });
      p.marker?.openPopup();
      sheet('normal');
    });
    return div;
  }

  async function findAttractions() {
    if (!state.places.length) { toast('Add at least one place first'); $('#place-search').focus(); return; }
    const { styles, extra, usedDefault } = activeStyles();
    const filters = Core.filtersFor(styles, extra);
    const radius = state.radius;
    const raw = await queryPois(filters, state.places, radius);

    const exclude = new Set(state.places.map((p) => p.osm).filter(Boolean));
    const ranked = Core.rankPois(raw, state.places, {
      radius, limit: Math.min(90, 15 * state.places.length), preferredStyles: styles, excludeIds: exclude,
    });
    state.attractions = ranked;

    layers.attractions.clearLayers();
    const box = $('#attraction-results');
    box.innerHTML = '';
    if (!ranked.length) {
      box.innerHTML = '<div class="empty-state">Nothing matched nearby. Try a bigger search radius or other styles.</div>';
      return;
    }
    for (const p of ranked) {
      p.marker = L.marker([p.lat, p.lon], { icon: icons.poi(p.style), title: p.name })
        .bindPopup(() => poiPopup(p), { maxWidth: 300 })
        .addTo(layers.attractions);
    }

    const summary = document.createElement('div');
    summary.className = 'summary';
    summary.textContent = `${ranked.length} suggestions${usedDefault ? ' (no style picked — showing top sights)' : ''}. Tap ＋ to add one to your places.`;
    box.appendChild(summary);

    // Group by nearest place, in list order.
    for (const place of state.places) {
      const group = ranked.filter((p) => p.near === place);
      if (!group.length) continue;
      const h = document.createElement('div');
      h.className = 'group-title';
      h.textContent = `Near ${place.name}`;
      box.appendChild(h);
      for (const p of group) box.appendChild(resultRow(p, { onAdd: addPoiAsPlace }));
    }
    fitAll();
  }

  function addPoiAsPlace(p) {
    addPlace({ name: p.name, address: describeAddress(p.tags) || (STYLES[p.style]?.label ?? ''), lat: p.lat, lon: p.lon, osm: p.id });
  }

  // ---------------------------------------------------------------------------
  // Hotels
  // ---------------------------------------------------------------------------
  async function findHotel() {
    if (!state.places.length) { toast('Add the places you want to visit first'); $('#place-search').focus(); return; }
    const center = Core.geometricMedian(state.places);
    const filters = [...state.lodging].map((k) => LODGING[k].filter);
    let radius = Core.hotelSearchRadius(center, state.places);
    let ranked = [];
    for (let attempt = 0; attempt < 4; attempt++) {
      const raw = await queryPois(filters, [center], radius);
      ranked = Core.rankHotels(raw, state.places, { minStars: state.minStars });
      if (ranked.length >= 5 || radius >= 40000) break;
      radius = Math.min(40000, radius * 2.5);
    }
    state.hotels = ranked;
    renderHotels(center);
  }

  function hotelPopup(h, rank) {
    const t = h.tags;
    const city = t['addr:city'] || '';
    const booking = `https://www.booking.com/searchresults.html?ss=${encodeURIComponent([h.name, city].filter(Boolean).join(', '))}`;
    const site = t.website || t['contact:website'];
    const rows = state.places.map((p, i) => `<tr><td>${i + 1}. ${esc(p.name)}</td><td>${fmt(h.distances[i])}</td></tr>`).join('');
    const kind = prettyTag(t.tourism || 'stay');
    return `<div class="pop">
      <h3>🏨 ${esc(h.name)}</h3>
      <div class="sub">#${rank} · ${esc(kind)}${h.stars ? ` · ${'★'.repeat(Math.round(h.stars))}` : ''} · avg ${fmt(h.avgDistance)} to your places</div>
      <table>${rows}</table>
      <div class="actions">
        <a class="main" href="${esc(booking)}" target="_blank" rel="noopener">Check prices</a>
        ${site && /^https?:\/\//i.test(site) ? `<a href="${esc(site)}" target="_blank" rel="noopener">Website</a>` : ''}
        <a href="${esc(gmapsUrl(h.name, h.lat, h.lon))}" target="_blank" rel="noopener">Google Maps</a>
      </div></div>`;
  }

  function drawHotelLines(h) {
    layers.lines.clearLayers();
    state.places.forEach((p, i) => {
      L.polyline([[h.lat, h.lon], [p.lat, p.lon]], { color: '#7c3aed', weight: 2.5, opacity: 0.75, dashArray: '6 6' })
        .bindTooltip(`${fmt(h.distances[i])} · ~${Core.walkingMinutes(h.distances[i])} min walk`, { sticky: true })
        .addTo(layers.lines);
    });
  }

  function renderHotels(center) {
    layers.hotels.clearLayers();
    layers.lines.clearLayers();
    const box = $('#hotel-results');
    box.innerHTML = '';
    const idealAvg = Core.averageDistance(center, state.places);

    if (state.places.length > 1) {
      L.marker([center.lat, center.lon], { icon: icons.center, interactive: true })
        .bindTooltip(`Ideal base point · avg ${fmt(idealAvg)} to your places`)
        .addTo(layers.hotels);
    }

    if (!state.hotels.length) {
      box.innerHTML = '<div class="empty-state">No matching stays found near your places in OpenStreetMap. Try allowing more lodging types or lowering the star filter.</div>';
      return;
    }

    const top = state.hotels.slice(0, 8);
    const best = top[0];
    const summary = document.createElement('div');
    summary.className = 'summary';
    summary.innerHTML = state.places.length > 1
      ? `Best spot to stay is around the dashed circle (avg ${fmt(idealAvg)}). <b>${esc(best.name)}</b> is ${fmt(best.avgDistance)} on average from your ${state.places.length} places.`
      : `Closest stays to <b>${esc(state.places[0].name)}</b>.`;
    box.appendChild(summary);

    top.forEach((h, i) => {
      h.marker = L.marker([h.lat, h.lon], { icon: icons.hotel(i === 0), zIndexOffset: i === 0 ? 900 : 500, title: h.name })
        .bindPopup(() => hotelPopup(h, i + 1), { maxWidth: 320 })
        .on('popupopen', () => drawHotelLines(h))
        .addTo(layers.hotels);

      const div = document.createElement('div');
      div.className = `result${i === 0 ? ' best' : ''}`;
      div.innerHTML = `<span class="emoji">${i === 0 ? '🏆' : '🏨'}</span>
        <div class="meta"><div class="name">${esc(h.name)}${i === 0 ? '<span class="badge">BEST MATCH</span>' : ''}</div>
        <div class="sub">${esc(prettyTag(h.tags.tourism))}${h.stars ? ` · ${'★'.repeat(Math.round(h.stars))}` : ''} · avg ${fmt(h.avgDistance)} · farthest ${fmt(h.maxDistance)}</div></div>`;
      div.addEventListener('click', () => {
        map.flyTo([h.lat, h.lon], Math.max(map.getZoom(), 15), { duration: 0.6 });
        h.marker.openPopup();
        sheet('normal');
      });
      box.appendChild(div);
    });

    drawHotelLines(best);
    const pts = [...state.places, ...top.slice(0, 3)].map((p) => [p.lat, p.lon]);
    map.flyToBounds(L.latLngBounds(pts).pad(0.2), { maxZoom: 16, duration: 0.8 });
  }

  // ---------------------------------------------------------------------------
  // Location & own suggestions
  // ---------------------------------------------------------------------------
  async function locate({ silent = false, focus = true } = {}) {
    $('#me-status').textContent = 'Locating you…';
    try {
      const me = await Api.locate();
      state.me = me;
      layers.me.clearLayers();
      if (me.accuracy && me.accuracy < 5000) L.circle([me.lat, me.lon], { radius: me.accuracy, color: '#0ea5e9', weight: 1, fillOpacity: 0.08 }).addTo(layers.me);
      const m = L.marker([me.lat, me.lon], { icon: icons.me, zIndexOffset: 2000, title: 'You are here' }).addTo(layers.me);
      $('#suggest-me').disabled = false;
      $('#me-status').textContent = me.approximate ? `Approximate location${me.label ? `: ${me.label}` : ''} (enable location for precision).` : 'Found you.';
      if (focus) map.flyTo([me.lat, me.lon], me.approximate ? 11 : 14, { duration: 0.8 });

      let where = me.label || '';
      try {
        const info = await Api.reverseGeocode(me.lat, me.lon, 14);
        if (info) where = [info.city, info.country].filter(Boolean).join(', ') || info.name;
      } catch { /* label is optional */ }
      m.bindPopup(`<div class="pop"><h3>📍 You are here</h3><div class="sub">${esc(where)}</div>
        <div class="actions"><button class="main" data-act-key="${registerAction(() => { map.closePopup(); withLoading($('#suggest-me'), suggestNearMe); })}">Suggest things near me</button></div></div>`);
      if (where) $('#me-status').textContent = `${me.approximate ? 'Approximately in' : 'You are in'} ${where}.`;
      return me;
    } catch (err) {
      $('#me-status').textContent = `${err.message}. You can still search places anywhere in the world.`;
      if (!silent) toast(err.message, 'error');
      return null;
    }
  }

  async function suggestNearMe() {
    if (!state.me) { await locate(); if (!state.me) return; }
    const me = state.me;
    const { styles, extra } = activeStyles();
    // Always blend in notable landmarks so there is something worth seeing.
    const mix = [...new Set([...styles, 'landmarks', 'viewpoints'])];
    const radius = me.approximate ? 8000 : 2500;
    const raw = await queryPois(Core.filtersFor(mix, extra), [me], radius);
    const anchor = { ...me, name: 'you' };
    const ranked = Core.rankPois(raw, [anchor], { radius, limit: 15, preferredStyles: styles });

    layers.near.clearLayers();
    const box = $('#near-results');
    box.innerHTML = '';
    if (!ranked.length) {
      box.innerHTML = '<div class="empty-state">No notable spots found around you in the map data.</div>';
      return;
    }
    const summary = document.createElement('div');
    summary.className = 'summary';
    summary.textContent = `Top ${ranked.length} picks around you, based on your style and what's notable nearby.`;
    box.appendChild(summary);
    for (const p of ranked) {
      p.marker = L.marker([p.lat, p.lon], { icon: icons.poi(p.style), title: p.name })
        .bindPopup(() => poiPopup(p), { maxWidth: 300 })
        .addTo(layers.near);
      box.appendChild(resultRow(p, { onAdd: addPoiAsPlace }));
    }
    const pts = [[me.lat, me.lon], ...ranked.map((p) => [p.lat, p.lon])];
    map.flyToBounds(L.latLngBounds(pts).pad(0.15), { maxZoom: 16, duration: 0.8 });
  }

  // ---------------------------------------------------------------------------
  // Mobile bottom sheet
  // ---------------------------------------------------------------------------
  const isMobile = () => window.matchMedia('(max-width: 760px)').matches;
  function sheet(mode) {
    if (!isMobile()) return;
    const panel = $('#panel');
    panel.classList.toggle('expanded', mode === 'expanded');
    panel.classList.toggle('collapsed', mode === 'collapsed');
    document.body.classList.toggle('sheet-expanded', mode === 'expanded');
    document.body.classList.toggle('sheet-collapsed', mode === 'collapsed');
    setTimeout(() => map.invalidateSize(), 300);
  }
  $('.brand').addEventListener('click', () => {
    const p = $('#panel');
    if (p.classList.contains('collapsed')) sheet('normal');
    else if (p.classList.contains('expanded')) sheet('collapsed');
    else sheet('expanded');
  });
  $('#place-search').addEventListener('focus', () => sheet('expanded'));

  // ---------------------------------------------------------------------------
  // Wire up
  // ---------------------------------------------------------------------------
  load();
  renderChips();
  renderPlaces();

  const text = $('#style-text');
  text.value = state.text;
  updateDetected();
  text.addEventListener('input', () => { state.text = text.value; save(); updateDetected(); });

  const radius = $('#radius');
  radius.value = state.radius;
  $('#radius-out').textContent = fmt(state.radius);
  radius.addEventListener('input', () => { state.radius = +radius.value; $('#radius-out').textContent = fmt(state.radius); save(); });

  const minStars = $('#min-stars');
  minStars.value = String(state.minStars);
  minStars.addEventListener('change', () => { state.minStars = +minStars.value; save(); });

  $('#find-attractions').addEventListener('click', (e) => withLoading(e.currentTarget, findAttractions));
  $('#find-hotel').addEventListener('click', (e) => withLoading(e.currentTarget, findHotel));
  $('#locate').addEventListener('click', (e) => withLoading(e.currentTarget, () => locate()));
  $('#fab-locate').addEventListener('click', () => locate());
  $('#suggest-me').addEventListener('click', (e) => withLoading(e.currentTarget, suggestNearMe));
  $('#fit-all').addEventListener('click', fitAll);
  $('#fab-fit').addEventListener('click', fitAll);
  $('#clear-places').addEventListener('click', () => {
    if (!confirm('Remove all places from your list?')) return;
    state.places = [];
    state.attractions = [];
    save();
    renderPlaces();
    invalidateHotels();
    layers.attractions.clearLayers();
    $('#attraction-results').innerHTML = '';
  });

  if (state.places.length) fitAll();

  // Find the user on start; only recentre on them when there is no trip yet.
  locate({ silent: true, focus: !state.places.length }).then((me) => {
    if (me && !state.places.length) withLoading($('#suggest-me'), suggestNearMe);
  });

  window.addEventListener('resize', () => map.invalidateSize());
})();
