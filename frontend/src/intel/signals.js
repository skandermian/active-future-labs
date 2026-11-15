/**
 * Signal vocabulary and pure queries over intel.json.
 *
 * Colours were checked with the dataviz validator on the console surface
 * (#0b0d10): amber / magenta / blue pass colour-blind separation (worst
 * deutan ΔE 13.2); drift is neutral white so it never competes with them.
 * Every type also has its own glyph, so meaning never rests on colour alone.
 */
export const SIGNAL_TYPES = Object.freeze({
  drift: { label: 'Drift', glyph: '▲', color: '#e6e8eb', question: 'Is the average moving?' },
  erratic: { label: 'Erratic', glyph: '≈', color: '#c98500', question: 'Are the swings getting bigger?' },
  steadier: { label: 'Steadier', glyph: '∼', color: '#c98500', hollow: true, question: 'Are the swings getting smaller?' },
  conflict: { label: 'Conflict', glyph: '✕', color: '#d55181', question: 'Do independent NASA systems disagree?' },
  migrate: { label: 'Migrate', glyph: '→', color: '#3987e5', question: 'Does the climate now resemble somewhere else?' },
});

export const FILTER_ORDER = ['all', 'drift', 'erratic', 'conflict', 'migrate', 'steadier'];

export const GRADE_TEXT = { confirmed: 'Confirmed', probable: 'Probable', possible: 'Lead' };

export function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Signals matching a type filter and a free-text query on site or headline. */
export function filterSignals(intel, regions, { type = 'all', query = '' } = {}) {
  const q = query.trim().toLowerCase();
  return intel.signals.filter((s) => {
    if (type !== 'all' && s.type !== type) return false;
    if (!q) return true;
    const r = regions[s.site];
    return (
      r.name.toLowerCase().includes(q) ||
      (r.country ?? '').toLowerCase().includes(q) ||
      s.headline.toLowerCase().includes(q)
    );
  });
}

/** The strongest signal type at a site, optionally limited to one type. */
export function siteLead(intel, siteIndex, type = 'all') {
  const site = intel.sites[siteIndex];
  if (!site) return null;
  const byId = signalIndex(intel);
  for (const id of site.signals) {
    const s = byId.get(id);
    if (type === 'all' || s.type === type) return s;
  }
  return null;
}

const indexCache = new WeakMap();
export function signalIndex(intel) {
  if (!indexCache.has(intel)) indexCache.set(intel, new Map(intel.signals.map((s) => [s.id, s])));
  return indexCache.get(intel);
}

/** Site code shown in the console: NASA_REGION_0217 -> 0217. */
export function siteCode(region) {
  return region.id.replace(/^\D+/, '').padStart(4, '0');
}

export function coordText(region) {
  return `${Math.abs(region.lat).toFixed(1)}°${region.lat >= 0 ? 'N' : 'S'} ${Math.abs(region.lon).toFixed(1)}°${region.lon >= 0 ? 'E' : 'W'}`;
}
