import { FILTER_ORDER, GRADE_TEXT, SIGNAL_TYPES, filterSignals } from '../intel/signals.js';
import { esc, fmtInt } from './dom.js';
import { explain } from './explain.js';

const PAGE = 100;

/**
 * Left column: detector tally (doubles as the filter), search, and the ranked
 * signal feed. Signals are ordered by the detector engine's priority score.
 */
export function createFeed({ root, core, store, onOpen }) {
  const { intel, regions } = core;
  const det = intel.detectors;
  let limit = PAGE;

  root.innerHTML = `
    <section class="tally" aria-label="Detectors">
      <header class="panel-head"><h2>Detectors</h2><span>${fmtInt(core.trends.n_tests)} series scanned</span></header>
      <div class="tally-grid" role="radiogroup" aria-label="Filter signals"></div>
      <ul class="tally-null">
        <li><span class="glyph" aria-hidden="true">◌</span><b>Early warning</b><span>${det.resilience.count} of ${fmtInt(det.resilience.tests)} · watched, nothing detected</span></li>
        <li><span class="glyph" aria-hidden="true">◌</span><b>Change types</b><span>no natural groups found</span></li>
      </ul>
      <div class="tally-explain">${explain('detectors')}</div>
    </section>
    <section class="feed" aria-label="Signal feed">
      <header class="panel-head">
        <h2>Signal feed</h2>
        <span class="feed-count" aria-live="polite"></span>
      </header>
      <label class="search">
        <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/></svg>
        <input type="search" placeholder="Search site, country or finding" autocomplete="off" aria-label="Search signals" />
      </label>
      <ol class="signal-list"></ol>
      <button class="more" type="button" hidden>Show more</button>
    </section>`;

  const tally = root.querySelector('.tally-grid');
  const list = root.querySelector('.signal-list');
  const more = root.querySelector('.more');
  const count = root.querySelector('.feed-count');
  const input = root.querySelector('input');

  const totals = { all: intel.signals.length, ...intel.totals };
  tally.innerHTML = FILTER_ORDER.map((k) => {
    const meta = k === 'all' ? { label: 'All signals', glyph: '◆', color: '#e6e8eb' } : SIGNAL_TYPES[k];
    return `<button type="button" role="radio" data-filter="${k}" style="--c:${meta.color}" ${meta.hollow ? 'data-hollow' : ''}>
      <span class="glyph" aria-hidden="true">${meta.glyph}</span>
      <span class="t-label">${esc(meta.label)}</span>
      <span class="t-count">${fmtInt(totals[k] ?? 0)}</span>
    </button>`;
  }).join('');

  tally.addEventListener('click', (e) => {
    const b = e.target.closest('[data-filter]');
    if (b) {
      limit = PAGE;
      store.set({ filter: b.dataset.filter });
    }
  });
  input.addEventListener('input', () => {
    limit = PAGE;
    store.set({ query: input.value });
  });
  more.addEventListener('click', () => {
    limit += PAGE;
    render();
  });
  list.addEventListener('click', (e) => {
    const row = e.target.closest('[data-signal]');
    if (row) onOpen(row.dataset.signal);
  });

  function render() {
    const { filter, query, selectedIndex } = store.get();
    for (const b of tally.querySelectorAll('[data-filter]')) b.setAttribute('aria-checked', String(b.dataset.filter === filter));
    const items = filterSignals(intel, regions, { type: filter, query });
    count.textContent = `${fmtInt(items.length)} shown`;
    list.innerHTML = items.slice(0, limit).map((s, k) => {
      const meta = SIGNAL_TYPES[s.type];
      const r = regions[s.site];
      return `<li><button type="button" class="signal" data-signal="${s.id}" ${s.site === selectedIndex ? 'aria-current="true"' : ''} style="--c:${meta.color}" ${meta.hollow ? 'data-hollow' : ''}>
        <span class="glyph" aria-hidden="true">${meta.glyph}</span>
        <span class="sig-main">
          <span class="sig-site">${esc(r.name)}<small>${esc(r.country ?? '')}</small></span>
          <span class="sig-head">${esc(s.headline)}</span>
        </span>
        <span class="sig-meta"><span class="grade grade-${s.grade}">${GRADE_TEXT[s.grade]}</span><span class="rank">#${k + 1}</span></span>
      </button></li>`;
    }).join('') || '<li class="empty">No signals match.</li>';
    more.hidden = items.length <= limit;
    more.textContent = `Show ${fmtInt(Math.min(PAGE, items.length - limit))} more`;
  }

  return { render };
}
