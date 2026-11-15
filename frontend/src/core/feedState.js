/**
 * Provenance envelope, after God's Eye View's `data/layerSnapshot.js`.
 *
 * Every layer reports one of these states through `getStats()`. The UI shows
 * the worst state across enabled layers, so a failed or partial data load can
 * never be presented as if everything were fine.
 */
export const FEED_STATES = Object.freeze([
  'nominal',
  'loading',
  'partial',
  'unavailable',
]);

/** Lower rank = more severe. */
const SEVERITY = Object.freeze({ unavailable: 0, loading: 1, partial: 2, nominal: 3, off: 4 });

export function worstState(states) {
  let worst = 'off';
  for (const s of states) if ((SEVERITY[s] ?? 0) < SEVERITY[worst]) worst = s;
  return worst;
}

export function describeState(state, detail = '') {
  switch (state) {
    case 'loading':
      return 'Loading NASA data…';
    case 'partial':
      return `Some data is missing${detail ? `: ${detail}` : ''}.`;
    case 'unavailable':
      return `Data could not be loaded${detail ? `: ${detail}` : ''}.`;
    default:
      return '';
  }
}
