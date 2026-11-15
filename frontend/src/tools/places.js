/**
 * Find a place by name or coordinates and match it to the nearest analysed site.
 * Pure helpers (testable in Node) plus a small OpenStreetMap geocoder for the browser.
 */

export function distanceKm(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * rad) / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lon2 - lon1) * rad) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Nearest of the analysed sites to a point: { index, km }. */
export function nearestSite(regions, lat, lon) {
  let best = { index: -1, km: Infinity };
  regions.forEach((r, index) => {
    const km = distanceKm(lat, lon, r.lat, r.lon);
    if (km < best.km) best = { index, km };
  });
  return best;
}

/** Instant, offline match on site names, nearest towns, regions and countries. */
export function localMatch(regions, query, { exactOnly = false } = {}) {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const fields = (r) => [r.name, r.nearest_place?.name, r.nearest_place?.admin1, r.country].filter(Boolean).map((s) => s.toLowerCase());
  const exact = regions.findIndex((r) => fields(r).slice(0, 2).some((f) => f === q));
  if (exact >= 0 || exactOnly) return exact >= 0 ? exact : null;
  const partial = regions.findIndex((r) => fields(r).some((f) => f.startsWith(q) || f.includes(q)));
  return partial >= 0 ? partial : null;
}

/** "53.48, -2.24" -> { lat, lon } */
export function parseCoords(query) {
  const m = query.trim().match(/^(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
}

/** Place name -> { label, lat, lon } using OpenStreetMap Nominatim (free, no key). */
export async function geocode(query, fetchFn = fetch) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&accept-language=en&q=${encodeURIComponent(query)}`;
  const res = await fetchFn(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Place search failed (${res.status})`);
  const hits = await res.json();
  if (!hits.length) return null;
  const parts = hits[0].display_name.split(',').map((s) => s.trim());
  return { label: [parts[0], parts.at(-1)].filter((v, i, a) => a.indexOf(v) === i).join(', '), lat: Number(hits[0].lat), lon: Number(hits[0].lon) };
}

/**
 * Resolve what the user typed to a point:
 * coordinates -> exact site/town name -> OpenStreetMap -> partial site name (offline fallback).
 */
export async function findPlace(regions, query, fetchFn = fetch) {
  const c = parseCoords(query);
  if (c) return { label: `${c.lat.toFixed(2)}, ${c.lon.toFixed(2)}`, ...c };
  const exact = localMatch(regions, query, { exactOnly: true });
  if (exact !== null) return { label: regions[exact].name, lat: regions[exact].lat, lon: regions[exact].lon, site: exact };
  try {
    const g = await geocode(query, fetchFn);
    if (g) return g;
  } catch {
    /* offline or blocked: fall back to the site list */
  }
  const partial = localMatch(regions, query);
  return partial === null ? null : { label: regions[partial].name, lat: regions[partial].lat, lon: regions[partial].lon, site: partial };
}
