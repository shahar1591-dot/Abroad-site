# Abroad — trip map planner

A static website that puts your trip on a map:

1. **Places I want to visit** — search any place on Earth (or click the map) to pin it. Your list is saved in the browser.
   **Import from Google Maps:** drop the whole [Google Takeout](https://takeout.google.com/) `.zip` (tick *Saved*, and *Maps (your places)* for starred places) straight in, no unzipping, then tick the lists you want for this trip. My Maps `.kmz`/`.kml` exports, single `.csv`/`.json` files, and pasted Google Maps links or place names also work. Entries that only have a name are looked up automatically; add the city or country to make those lookups accurate. Each place remembers its list, so you can remove a whole list in one click, and re-importing shows what's already on the map. (Google has no public API for reading saved lists outside the EU/UK, so an export is the supported route. Short `maps.app.goo.gl` links need to be opened once and the full address pasted.)
2. **What I like** — pick attraction styles (museums, history, nature, views, food, nightlife, beaches, sacred places, family, shopping…) and/or describe your taste in your own words ("street food, jazz bars, ancient ruins"). Abroad suggests matching attractions near each of your places; tap ＋ to add one to your list.
3. **Where to stay** — finds the hotel / guest house / apartment / hostel with the shortest *average* distance to all your places (using the geometric median of your list as the ideal base point). Shows the distance to every place and links to check prices.
4. **Around me** — detects your current location (GPS, with an approximate IP fallback) and suggests notable things nearby.

Free-text descriptions understand English plus some Hebrew, Spanish and French keywords; any other word (e.g. "sushi", "jazz") is searched directly in cuisine and venue names.

## How it works

No API keys, no backend — everything runs in the browser and works worldwide:

| Need | Service |
| --- | --- |
| Map | [Leaflet](https://leafletjs.com) + OpenStreetMap / OpenTopoMap tiles |
| Search & reverse geocoding | [Nominatim](https://nominatim.org) |
| Attractions & hotels | [Overpass API](https://overpass-api.de) (OpenStreetMap data, with fallback mirrors) |
| Your location | Browser Geolocation API, fallback to ipapi.co |

Distances are straight-line; walking times are rough estimates.

## Run locally

```sh
npm start        # serves on http://localhost:8000 (needs python3)
npm test         # unit tests for the geo/ranking logic (Node 18+)
```

Geolocation needs `https://` or `localhost`. To publish, enable **GitHub Pages** for this repository (Settings → Pages → deploy from branch, root folder).

## Files

- `index.html` — layout
- `css/style.css` — styling (desktop sidebar, mobile bottom sheet, dark mode)
- `js/core.js` — pure logic: distances, geometric median, style keywords, Overpass queries, ranking, Google Maps import parsers
- `js/api.js` — Nominatim / Overpass / geolocation calls
- `js/app.js` — map and UI
