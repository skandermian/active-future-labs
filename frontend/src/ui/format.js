/** Plain-language formatting shared by the panel, legend and tools. Pure. */

export function formatNumber(value, decimals = 2) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '–';
  const abs = Math.abs(value);
  const d = abs >= 100 ? 0 : abs >= 10 ? Math.min(decimals, 1) : decimals;
  return value.toLocaleString('en-GB', { minimumFractionDigits: d, maximumFractionDigits: d });
}

export function formatSigned(value, decimals = 2) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '–';
  return `${value > 0 ? '+' : value < 0 ? '−' : ''}${formatNumber(Math.abs(value), decimals)}`;
}

export function formatP(p) {
  if (p === null || p === undefined) return '–';
  if (p < 0.001) return '< 0.001';
  // 4 decimals so a value just under 0.05 never displays as "0.050".
  return p.toFixed(4);
}

export const VERDICT_TEXT = {
  significant: 'Significant',
  suggestive: 'Possible, not confirmed',
  not_significant: 'Could be chance',
  no_data: 'Not enough data',
};

/**
 * One sentence a student can read: what, where, how much, how sure.
 * rec is a trendRecord(); words are the variable's [down, up] pole words.
 */
export function verdictSentence(rec, words, nTests) {
  if (!rec?.available) return `There isn’t enough reliable ${rec?.variable?.label?.toLowerCase() ?? 'data'} here to test for a trend.`;
  const dir = rec.slope > 0 ? words[1] : words[0];
  const amount = `${formatSigned(rec.slope, rec.variable.decimals)} ${rec.variable.unit} per decade`;
  switch (rec.verdict) {
    case 'significant':
      return `Getting ${dir}: ${amount}. This is very unlikely to be chance, even after checking all ${nTests.toLocaleString('en-GB')} place-and-variable combinations.`;
    case 'suggestive':
      return `Possibly getting ${dir} (${amount}), but after allowing for testing so many places at once, chance can’t be ruled out.`;
    default:
      return `No clear trend: ${amount}, which is small compared with normal year-to-year swings. A longer record might settle it.`;
  }
}
