import { GRADE_TEXT, SIGNAL_TYPES, coordText, signalIndex, siteCode } from '../intel/signals.js';
import { trendRecord } from '../sources/trendData.js';
import { colorForChange } from '../layers/colorScale.js';
import { formatP, formatSigned } from './format.js';
import { renderTrendChart } from './chart.js';
import { esc, fmtInt } from './dom.js';

const GROUPS = [
  { system: 'MERRA-2', note: 'reanalysis model', vars: ['T2M', 'RH2M', 'PRECTOTCORR', 'GWETTOP'] },
  { system: 'GPM IMERG', note: 'satellite', vars: ['gpm_rain'] },
  { system: 'GLDAS', note: 'land model', vars: ['evaporation', 'runoff', 'soil_moisture'] },
  { system: 'MERRA-2 aerosol', note: 'reanalysis model', vars: ['aerosol', 'dust'] },
];
const PAIR_LABEL = { rain: 'Rain · MERRA-2 vs GPM IMERG', soil: 'Soil · MERRA-2 vs GLDAS' };
const PAIR_STATE = {
  corroborated: ['Agree', 'Both significant, same direction'],
  contradicted: ['Contradict', 'Both significant, opposite directions'],
  contested: ['Disputed', 'One significant, the other points the other way'],
  single_source: ['One source', 'Only one system shows a significant change'],
  quiet: ['Quiet', 'Neither shows a significant change'],
  no_data: ['No data', 'Not enough land in this box for GLDAS'],
};

/**
 * Right column: the case file for one site. Everything is read from the
 * detector output and the backend's trend table; nothing is recomputed here
 * except the display chart.
 */
export function createDossier({ root, core, source, store, onSelectSite }) {
  let token = 0;

  root.addEventListener('click', (e) => {
    const v = e.target.closest('[data-focus]');
    if (v) store.set({ focusVar: v.dataset.focus });
    const s = e.target.closest('[data-site]');
    if (s) onSelectSite(Number(s.dataset.site));
    if (e.target.closest('[data-close]')) store.set({ selectedIndex: null });
  });

  async function render() {
    const mine = ++token;
    const { selectedIndex, focusVar } = store.get();
    if (selectedIndex === null) {
      root.innerHTML = briefingHtml(core);
      return;
    }
    const variable = focusVar ?? 'T2M';
    const [monthly, annual] = await Promise.all([source.monthly(variable), source.annual(variable)]);
    if (mine !== token) return;
    root.innerHTML = dossierHtml(core, selectedIndex, variable);
    const rec = trendRecord(core, selectedIndex, variable);
    const accent = rec.available ? `rgb(${colorForChange(rec.slope, rec.scale, variable).join(' ')})` : '#e6e8eb';
    renderTrendChart(root.querySelector('[data-chart]'), {
      monthly: monthly.values[selectedIndex],
      startYear: Number(monthly.start.slice(0, 4)),
      annual: annual.values[selectedIndex],
      years: annual.years,
      rec,
      accent,
    });
    root.scrollTop = 0;
  }
  return { render };
}

function briefingHtml(core) {
  const { intel, regions } = core;
  const top = [...intel.sites.keys()].sort((a, b) => intel.sites[a].rank - intel.sites[b].rank).slice(0, 6);
  const d = intel.detectors;
  return `
    <header class="panel-head"><h2>Briefing</h2><span>2000–2024 archive</span></header>
    <div class="dossier-body">
      <p class="brief-lede">The engine scanned ${fmtInt(regions.length)} sites across four NASA systems and raised ${fmtInt(intel.signals.length)} signals. It looks past the average: for places getting more erratic, for NASA records that contradict each other, and for climates that now resemble somewhere else.</p>
      <dl class="brief-stats">
        ${['drift', 'erratic', 'conflict', 'migrate'].map((k) => `
          <div style="--c:${SIGNAL_TYPES[k].color}"><dt><span class="glyph">${SIGNAL_TYPES[k].glyph}</span>${SIGNAL_TYPES[k].label}</dt>
          <dd>${fmtInt(intel.totals[k])}</dd><p>${esc(SIGNAL_TYPES[k].question)}</p></div>`).join('')}
      </dl>
      <h3 class="sub">Highest-priority sites</h3>
      <ol class="site-list">
        ${top.map((i) => `<li><button type="button" data-site="${i}">
          <span class="code">${siteCode(regions[i])}</span>
          <span class="site-name">${esc(regions[i].name)}<small>${esc(regions[i].country ?? '')} · ${esc(regions[i].climate.label)}</small></span>
          <span class="counts">${countsHtml(intel.sites[i].counts)}</span>
        </button></li>`).join('')}
      </ol>
      <h3 class="sub">Read with care</h3>
      <ul class="caveats">
        <li>${esc(d.migrate.caveat)}</li>
        <li>${esc(d.erratic.caveat)}</li>
        <li>${esc(d.resilience.note)} (${d.resilience.raw_hits} raw hits in ${fmtInt(d.resilience.tests)} tests, about what chance alone gives.)</li>
      </ul>
    </div>`;
}

function countsHtml(c) {
  return ['drift', 'erratic', 'conflict', 'migrate']
    .filter((k) => c[k])
    .map((k) => `<span style="--c:${SIGNAL_TYPES[k].color}" title="${SIGNAL_TYPES[k].label}"><i>${SIGNAL_TYPES[k].glyph}</i>${c[k]}</span>`)
    .join('');
}

function dossierHtml(core, i, focusVar) {
  const { intel, regions, variables } = core;
  const r = regions[i];
  const site = intel.sites[i];
  const byId = signalIndex(intel);
  const sigs = site.signals.map((id) => byId.get(id));
  const near = r.nearest_place;

  const signalRows = sigs.map((s) => {
    const meta = SIGNAL_TYPES[s.type];
    const target = s.type === 'migrate' ? `<button type="button" class="jump" data-site="${s.target}">Open ${esc(regions[s.target].name)}</button>` : '';
    const focus = s.var && variables[s.var] ? s.var : s.pair?.[0];
    return `<li style="--c:${meta.color}" ${meta.hollow ? 'data-hollow' : ''}>
      <span class="glyph" aria-hidden="true">${meta.glyph}</span>
      <div><button type="button" class="sig-link" ${focus ? `data-focus="${focus}"` : ''}>${esc(s.headline)}</button>
      <small>${meta.label} · ${GRADE_TEXT[s.grade]}${s.q !== null ? ` · q ${formatP(s.q)}` : ''}</small>${target}</div>
    </li>`;
  }).join('') || '<li class="empty">No signals at this site.</li>';

  const pairs = Object.entries(site.pairs).map(([k, state]) => {
    const [label, help] = PAIR_STATE[state];
    return `<li data-state="${state}"><span>${PAIR_LABEL[k]}</span><b title="${esc(help)}">${label}</b></li>`;
  }).join('');

  const matrix = GROUPS.map((g) => `
    <tbody>
      <tr class="group"><th colspan="4">${esc(g.system)} <small>${esc(g.note)}</small></th></tr>
      ${g.vars.map((v) => {
        const rec = trendRecord(core, i, v);
        const vol = site.volatility[v];
        const res = site.resilience[v];
        const sig = rec.verdict === 'significant';
        const volSig = vol.q !== null && vol.q < intel.alpha;
        const dir = rec.available ? (rec.slope > 0 ? '▲' : '▼') : '';
        const sw = rec.available ? `<i class="sw" style="background:rgb(${colorForChange(rec.slope, rec.scale, v).join(' ')})"></i>` : '';
        return `<tr ${v === focusVar ? 'aria-current="true"' : ''}>
          <th scope="row"><button type="button" data-focus="${v}">${esc(variables[v].label)}</button></th>
          <td class="${sig ? 'hit' : 'miss'}">${sw}${rec.available ? `${dir} ${formatSigned(rec.slope, variables[v].decimals)}` : '–'}</td>
          <td class="${volSig ? 'hit' : 'miss'}">${vol.pct === null ? '–' : `${formatSigned(vol.pct, 0)}%`}</td>
          <td class="miss">${res ? (res.tau === null ? '–' : `τ ${formatSigned(res.tau, 2)}`) : '·'}</td>
        </tr>`;
      }).join('')}
    </tbody>`).join('');

  const v = variables[focusVar];
  const rec = trendRecord(core, i, focusVar);
  const analogue = site.analogue !== null ? regions[site.analogue] : null;

  return `
    <header class="panel-head dossier-head">
      <h2>Site ${siteCode(r)}</h2>
      <span>Priority #${site.rank} of ${regions.length}</span>
      <button type="button" class="icon-button" data-close aria-label="Close dossier"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg></button>
    </header>
    <div class="dossier-body">
      <div class="ident">
        <h3 class="site-title">${esc(r.name)}</h3>
        <p>${esc(r.country ?? '')} · ${esc(r.climate.label)} · ${coordText(r)}</p>
        <p class="muted">${near.distance_km <= 250 ? `Nearest town ${esc(near.name)}, ${near.distance_km} km` : `Remote: ${near.distance_km} km to ${esc(near.name)}`} · 2°×2° box</p>
      </div>

      <section class="assessment">
        <h4>Assessment</h4>
        <p>${esc(site.assessment)}</p>
      </section>

      <section>
        <h4>Signals <span>${sigs.length}</span></h4>
        <ul class="site-signals">${signalRows}</ul>
      </section>

      <section>
        <h4>Do the sources agree?</h4>
        <ul class="pairs">${pairs}</ul>
      </section>

      <section>
        <h4>Evidence matrix <span>tap a row to chart it</span></h4>
        <table class="matrix">
          <thead><tr><th scope="col">Record</th><th scope="col">Drift /dec</th><th scope="col">Swings /dec</th><th scope="col">Memory</th></tr></thead>
          ${matrix}
        </table>
        <p class="caption">Bright = significant after correction across all sites. Drift: change in the average. Swings: change in the size of month-to-month departures. Memory: early-warning indicator (rising = slower recovery); none significant anywhere.</p>
      </section>

      <section>
        <h4>${esc(v.label)} <span>${esc(v.source)}</span></h4>
        <div class="chart-slot" data-chart></div>
        <p class="caption">Monthly departures from this site's normal (line), yearly average (dots), trend with 95% range (fan) and ±1 s.d. swing band (shaded). Trend ${rec.available ? `${formatSigned(rec.slope, v.decimals)} ${esc(v.unit)} per decade, adjusted p ${formatP(rec.pAdjusted)}` : 'not fitted'}.</p>
      </section>

      ${analogue ? `<section class="analogue">
        <h4>Climate match</h4>
        <p>This site's 2020–24 climate (temperature, rain, humidity, topsoil wetness by month) is closest to <b>${esc(analogue.name)}</b>, ${esc(analogue.country ?? '')}, as it was in 2000–04.</p>
        <button type="button" class="jump" data-site="${site.analogue}">Open ${esc(analogue.name)}</button>
      </section>` : ''}

      <details class="provenance">
        <summary>Sources and methods</summary>
        ${Object.values(intel.detectors).filter((d) => d.method).map((d) => `<p><b>${esc(d.label)}.</b> ${esc(d.method)}</p>`).join('')}
        <p><b>Data.</b> ${GROUPS.map((g) => esc(g.system)).join(', ')}; monthly ${esc(core.manifest.period.start)} to ${esc(core.manifest.period.end)}, area-averaged over the box.</p>
      </details>
    </div>`;
}
