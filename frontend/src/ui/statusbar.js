import { esc, fmtInt } from './dom.js';

const SYSTEMS = [
  { id: 'MERRA-2', vars: ['T2M', 'RH2M', 'PRECTOTCORR', 'GWETTOP'] },
  { id: 'MERRA-2 AER', vars: ['aerosol', 'dust'] },
  { id: 'GPM IMERG', vars: ['gpm_rain'] },
  { id: 'GLDAS', vars: ['evaporation', 'runoff', 'soil_moisture'] },
];

/** Top status bar: what the console is watching and whether every feed loaded. */
export function renderStatusbar(el, core, feedState) {
  const fitted = (v) => core.trends.variables[v].slope.filter((s) => s !== null).length;
  const feeds = SYSTEMS.map((s) => {
    const n = s.vars.reduce((a, v) => a + fitted(v), 0);
    const full = s.vars.length * core.regions.length;
    const state = feedState !== 'nominal' ? feedState : n === 0 ? 'unavailable' : 'nominal';
    return `<li class="feed-pill" data-state="${state}" title="${esc(`${s.id}: ${fmtInt(n)} of ${fmtInt(full)} series fitted`)}"><i></i>${esc(s.id)}</li>`;
  }).join('');
  el.innerHTML = `
    <div class="wordmark"><b>EARTHWATCH</b><span>Earth change intelligence</span></div>
    <ul class="feeds" aria-label="Data feeds">${feeds}</ul>
    <dl class="sb-stats">
      <div><dt>Sites</dt><dd>${fmtInt(core.regions.length)}</dd></div>
      <div><dt>Series</dt><dd>${fmtInt(core.trends.n_tests)}</dd></div>
      <div><dt>Signals</dt><dd>${fmtInt(core.intel.signals.length)}</dd></div>
      <div><dt>Archive</dt><dd>${esc(core.manifest.period.start)} → ${esc(core.manifest.period.end)}</dd></div>
    </dl>
    <div class="sb-team">Active Future Labs · NASA Space Apps 2026</div>`;
}
