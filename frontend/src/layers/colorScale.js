/**
 * Diverging colour scale for "which way and how much", built for a dark globe.
 *
 * Blue <-> neutral grey <-> red, interpolated in OKLab. Both arms get brighter
 * and more saturated as the change grows, so small changes recede and large
 * ones stand out. The two poles were checked with the dataviz validator for
 * colour-blind separation on the dark surface (worst protan ΔE 11.8 at the
 * weakest step, 16–19.5 at the strong steps).
 *
 * Pure module: no Cesium, no DOM. Tested in tests/colorScale.test.mjs.
 */
export const SURFACE = '#0e1116';
export const NEUTRAL = '#4d4d4b';
export const BLUE_ARM = ['#426593', '#5082c4', '#61a0f4', '#98c4ff']; // near -> far
export const RED_ARM = ['#8d4f48', '#bb635a', '#e8796e', '#fea69c']; // near -> far

/** Variables where an increase reads as "warmer / drier / hazier" (red). */
const INCREASE_IS_RED = new Set(['T2M', 'aerosol', 'dust', 'evaporation']);

export function polarity(variableId) {
  return INCREASE_IS_RED.has(variableId) ? 1 : -1;
}

/** Words for each pole of a variable, used by the legend and the panel. */
export function poleWords(variableId) {
  const words = {
    T2M: ['cooler', 'warmer'],
    RH2M: ['drier air', 'more humid'],
    aerosol: ['clearer', 'hazier'],
    dust: ['less dust', 'more dust'],
    PRECTOTCORR: ['less rain', 'more rain'],
    gpm_rain: ['less rain', 'more rain'],
    evaporation: ['less evaporation', 'more evaporation'],
    runoff: ['less runoff', 'more runoff'],
    GWETTOP: ['drier soil', 'wetter soil'],
    soil_moisture: ['drier soil', 'wetter soil'],
  };
  return words[variableId] ?? ['decreasing', 'increasing'];
}

// ---- OKLab ---------------------------------------------------------------
const toLin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toSrgb = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.max(c, 0) ** (1 / 2.4) - 0.055);

export function hexToOklab(hex) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => toLin(v / 255));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806757646 * g + 0.1073816492 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

export function oklabToRgb([L, A, B]) {
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  const rgb = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return rgb.map((c) => Math.round(Math.min(1, Math.max(0, toSrgb(c))) * 255));
}

const STOPS = [...BLUE_ARM].reverse().concat([NEUTRAL], RED_ARM).map(hexToOklab);

/** t in [-1, 1]: -1 = strongest blue, 0 = neutral, +1 = strongest red. */
export function diverging(t) {
  const x = (Math.max(-1, Math.min(1, Number.isFinite(t) ? t : 0)) + 1) / 2; // 0..1
  const pos = x * (STOPS.length - 1);
  const i = Math.min(STOPS.length - 2, Math.floor(pos));
  const f = pos - i;
  const a = STOPS[i];
  const b = STOPS[i + 1];
  return oklabToRgb([0, 1, 2].map((k) => a[k] + (b[k] - a[k]) * f));
}

/** Colour for a change value given the variable's 95th-percentile scale. */
export function colorForChange(value, scale, variableId) {
  if (value === null || value === undefined || !scale) return null;
  return diverging((polarity(variableId) * value) / scale);
}

/** How strongly a box is drawn, by how much the evidence supports it. */
export function evidenceAlpha(verdict) {
  return { significant: 0.9, suggestive: 0.5, not_significant: 0.16 }[verdict] ?? 0;
}

/**
 * CSS gradient for a legend whose numbers run negative (left) to positive
 * (right). For "wetter is blue" variables the gradient therefore runs red to
 * blue, so the number line and the colours always agree with the globe.
 */
export function legendGradient(variableId, steps = 11) {
  const stops = [];
  for (let k = 0; k < steps; k++) {
    const t = -1 + (2 * k) / (steps - 1);
    const rgb = diverging(polarity(variableId) * t);
    stops.push(`rgb(${rgb.join(' ')}) ${((100 * k) / (steps - 1)).toFixed(1)}%`);
  }
  return `linear-gradient(90deg, ${stops.join(', ')})`;
}
