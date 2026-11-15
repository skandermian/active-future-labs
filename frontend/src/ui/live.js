/**
 * Live analysis of the exact spot a user searched or clicked, from the Python
 * server (backend/server/app.py). If no server is configured (VITE_API_URL) or
 * it can't be reached, the site falls back to the nearest analysed area.
 */
import { formatP, formatSigned } from './format.js';
import { esc } from './dom.js';
import { WORDS, explain } from './explain.js';
import { outlookHtml } from './deep.js';

export const API = (import.meta.env?.VITE_API_URL ?? '').replace(/\/$/, '');

/** Wake a sleeping free-tier server as soon as the page opens. */
export function warmUp(fetchFn = fetch) {
  if (API) fetchFn(`${API}/api/health`).catch(() => {});
}

/**
 * One automatic second try for the errors that are usually temporary: the free
 * server waking up (502/503/504), NASA being slow, or a dropped connection.
 * Bad input (4xx, e.g. "this is ocean") is shown straight away.
 */
export async function fetchLive({ lat, lon, label, radius = 0 }, fetchFn = fetch, timeoutMs = 90_000, tries = 2) {
  let last;
  for (let k = 0; k < tries; k++) {
    try {
      return await fetchOnce({ lat, lon, label, radius }, fetchFn, timeoutMs);
    } catch (e) {
      last = e;
      if (!e.temporary) break;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  throw last;
}

async function fetchOnce({ lat, lon, label, radius }, fetchFn, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const fail = (msg, temporary) => Object.assign(new Error(msg), { temporary });
  try {
    const q = new URLSearchParams({ lat: lat.toFixed(3), lon: lon.toFixed(3), label: label ?? '', radius_km: String(radius) });
    let res;
    try {
      res = await fetchFn(`${API}/api/place?${q}`, { signal: ctrl.signal });
    } catch (e) {
      throw e.name === 'AbortError'
        ? fail('The live server took too long to answer (NASA can be slow for some places). Try again.', true)
        : fail('Could not reach the live server. Check your connection, or it may still be waking up.', true);
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw fail(body.detail || `Live server error ${res.status}`, res.status >= 500);
    return body;
  } finally {
    clearTimeout(timer);
  }
}

const VERDICT = { significant: ['Significant', 'hit'], suggestive: ['Possible', 'maybe'], not_significant: ['Could be chance', 'miss'] };
const pct = (x) => (x === null || x === undefined ? '–' : x > 0.999 ? '>99.9%' : `${Math.round(x * 100)}%`);
const GROUPS = [
  { title: 'Measured at this exact spot', note: 'NASA POWER, 1981–2024', test: (s) => !/nearest analysed site/.test(s) },
  { title: 'From the nearest analysed area', note: 'GLDAS · GPM · aerosol, 2000–24', test: (s) => /nearest analysed site/.test(s) },
];

function plainSummary(d) {
  const out = [];
  const say = (v, extra = '') => {
    const x = d.variables[v];
    if (!x?.trend) return;
    const m = d.meta[v];
    const [down, up] = WORDS[v] ?? ['lower', 'higher'];
    const total = x.trend.slope * ((x.trend.last_year - x.trend.first_year + 1) / 10);
    const word = x.trend.slope > 0 ? up : down;
    if (x.trend.verdict === 'significant') out.push(`it has got <b>${esc(word)}</b>, by about ${formatSigned(total, m.decimals)} ${esc(m.unit)} since ${x.trend.first_year}${extra}, and that is very unlikely to be luck`);
    else if (x.trend.verdict === 'suggestive') out.push(`it may have got ${esc(word)} (${formatSigned(total, m.decimals)} ${esc(m.unit)} since ${x.trend.first_year}), but that isn't proven`);
    else out.push(`there is <b>no clear change</b> in ${esc(m.label.toLowerCase())}`);
  };
  say('T2M');
  say('PRECTOTCORR');
  return out.length ? `In plain words: ${out.join('; ')}.` : '';
}

/** The exact-spot section at the top of the dossier. */
export function liveHtml(live, core, liveVar) {
  if (!live) return '';
  const radius = live.radius ?? 0;
  const picker = `<div class="radius" role="group" aria-label="Area to analyse">
      ${[[0, 'This spot'], [100, '100 km area'], [250, '250 km area']].map(([r, t]) =>
        `<button type="button" data-radius="${r}" aria-pressed="${r === radius}">${t}</button>`).join('')}
    </div>`;
  if (live.status === 'loading')
    return `<section class="live"><h4>Your spot, live from NASA <span>1981–2024</span></h4>${picker}
      <p class="live-wait">Downloading 44 years of NASA data for ${radius ? `a ${radius} km area` : 'this exact spot'} and running every test…
      <small>Usually 5–15 seconds; the first search after a quiet spell can take up to a minute while the server wakes up.</small></p></section>`;
  if (live.status === 'error')
    return `<section class="live"><h4>Your spot, live from NASA</h4>${picker}
      <p class="live-wait">Couldn't get live data: ${esc(live.message)} The results below are for the nearest analysed area.</p></section>`;
  const d = live.data;
  const rows = (g) => Object.entries(d.variables).filter(([, x]) => g.test(x.source) && x.trend).map(([v, x]) => {
    const m = d.meta[v];
    const [label, cls] = VERDICT[x.trend.verdict];
    return `<tr ${v === liveVar ? 'aria-current="true"' : ''}>
      <th scope="row"><button type="button" data-live-var="${v}" title="${esc(m.definition)}">${esc(m.label)}</button></th>
      <td>${formatSigned(x.trend.slope, m.decimals)}<small>${esc(m.unit)}</small></td>
      <td class="${cls}">${label}<small>Mann-Kendall p ${x.mk ? formatP(x.mk.p) : '–'}</small></td>
      <td>${pct(x.deep?.sure)}</td>
    </tr>`;
  }).join('');
  const table = GROUPS.map((g) => {
    const r = rows(g);
    return r ? `<tbody><tr class="group"><th colspan="4">${g.title} <small>${g.note}${g === GROUPS[1] ? ` · ${esc(d.nearest_site.name)}, ${Math.round(d.nearest_site.km)} km` : ''}</small></th></tr>${r}</tbody>` : '';
  }).join('');
  const v = d.variables[liveVar] ? liveVar : 'T2M';
  const x = d.variables[v];
  const m = d.meta[v];
  const fakeCore = { deep: { sites: [{ hazards: d.outlook.hazards, dry_spells: d.outlook.dry_spells, aridity: d.outlook.aridity, hazards_rising: d.outlook.hazards_rising }] } };
  return `<section class="live">
      <h4>Your spot, live from NASA <span>${d.period[0]}–${d.period[1]}</span></h4>
      ${picker}
      <p class="plain">${plainSummary(d)}</p>
      ${explain('live')}
      <table class="matrix live-table">
        <thead><tr><th scope="col">Measurement</th><th scope="col">Per decade</th><th scope="col">Verdict</th><th scope="col">Sure</th></tr></thead>
        ${table}
      </table>
      <p class="caption">Verdict "Significant" = both the trend test (HAC, corrected for testing ${Object.keys(d.variables).length} measurements here) and Mann-Kendall agree. Tap a row to chart it.</p>
      <h4 class="live-chart-head">${esc(m.label)} <span>${esc(m.source)}</span></h4>
      <div class="chart-slot" data-live-chart></div>
      <p class="caption">${x?.trend ? `Trend ${formatSigned(x.trend.slope, m.decimals)} ${esc(m.unit)} per decade (95% range ${formatSigned(x.trend.ci[0], m.decimals)} to ${formatSigned(x.trend.ci[1], m.decimals)}), Mann-Kendall p ${formatP(x.mk?.p)}, Sen's slope ${formatSigned(x.mk?.sen, m.decimals)}.` : ''}</p>
      ${outlookHtml(fakeCore, 0, { early: `${d.baseline[0]}–${d.baseline[1]}`, baseline: `${d.baseline[0]}–${d.baseline[1]}`, head: `${d.baseline[0]}–${String(d.baseline[1]).slice(2)} vs ${d.recent[0]}–${String(d.recent[1]).slice(2)}` })}
    </section>`;
}

/** Data for renderTrendChart from a live series. */
export function liveChartInput(d, v) {
  const s = d.series?.[v];
  const x = d.variables?.[v];
  if (!s || !x?.trend) return null;
  const vals = s.values;
  const sums = new Array(12).fill(0);
  const counts = new Array(12).fill(0);
  vals.forEach((val, i) => { if (val !== null) { sums[i % 12] += val; counts[i % 12] += 1; } });
  const anom = vals.map((val, i) => (val === null || !counts[i % 12] ? null : val - sums[i % 12] / counts[i % 12]));
  const years = [];
  const annual = [];
  for (let y = 0; y < anom.length / 12; y++) {
    const yr = anom.slice(y * 12, y * 12 + 12);
    years.push(s.start + y);
    annual.push(yr.every((a) => a !== null) ? yr.reduce((a, b) => a + b, 0) / 12 : null);
  }
  const m = d.meta[v];
  return {
    monthly: vals, startYear: s.start, annual, years,
    rec: { available: true, slope: x.trend.slope, ciLow: x.trend.ci[0], ciHigh: x.trend.ci[1], variable: { label: m.label, unit: m.unit, decimals: m.decimals } },
  };
}
