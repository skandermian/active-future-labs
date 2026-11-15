/**
 * Disaster outlook and deep statistics, read from deep.json
 * (backend/intel/deep_stats.py). Pure HTML builders, like the rest of ui/.
 */
import { formatP, formatSigned } from './format.js';
import { esc, fmtInt } from './dom.js';
import { WORDS, explain } from './explain.js';

const HAZARDS = [
  { id: 'heat', label: 'Heatwave months', what: 'hotter than the hottest 10% of that month in BASE' },
  { id: 'drought', label: 'Dry-soil months', what: 'topsoil drier than the driest 10% of that month in BASE' },
  { id: 'flood', label: 'Very wet months', what: 'rainier than the wettest 10% of that month in BASE' },
  { id: 'fire', label: 'Fire-weather months', what: 'hot (top 25%) and dry air (bottom 25%) at the same time' },
];
const VERDICT = {
  rising: ['Rising', 'More common, significant after checking all 360 sites'],
  watch: ['Watch', 'More common, not yet significant'],
  falling: ['Falling', 'Less common, significant'],
  steady: ['Steady', 'No clear change'],
};
const pct = (x) => (x === null || x === undefined ? '–' : x > 0.999 ? '>99.9%' : `${Math.round(x * 100)}%`);
const num = (x, d = 1) => (x === null || x === undefined ? '–' : Number(x).toFixed(d));

/** Site-level: hazards, dry spells, aridity, stability. */
export function outlookHtml(core, i, { baseline = '2000–2011', head = '2000–11 vs 2012–24', early = 'the early 2000s' } = {}) {
  const s = core.deep?.sites?.[i];
  if (!s) return '';
  const rising = HAZARDS.filter((h) => s.hazards[h.id].verdict === 'rising');
  const watch = HAZARDS.filter((h) => s.hazards[h.id].verdict === 'watch');
  const lede = rising.length
    ? `${rising.length} hazard${rising.length > 1 ? 's' : ''} significantly more common: ${rising.map((h) => h.label.toLowerCase()).join(', ')}.`
    : 'No hazard has become significantly more common.';
  const rows = HAZARDS.map((h) => {
    const z = s.hazards[h.id];
    const [label, help] = VERDICT[z.verdict];
    return `<li data-risk="${z.verdict}">
      <div class="hz-name"><span>${h.label}</span><small>${esc(h.what.replace('BASE', baseline))}</small></div>
      <div class="hz-nums">
        <b class="hz-verdict" title="${esc(help)} · odds ×${num(z.ratio, 2)}/decade · p ${formatP(z.p)} · q ${formatP(z.q)}">${label}</b>
        <span>${num(z.before)} → <b>${num(z.after)}</b> a year</span>
        <small>now ${pct(z.now)} of months (was ${pct(z.base)})</small>
      </div>
    </li>`;
  }).join('');
  const d = s.dry_spells;
  const dry = d ? `<li><span>Dry spells</span><p>Average run of dry months <b>${num(d.spell_before)} → ${num(d.spell_after)}</b>;
      chance a dry month is followed by another ${pct(d.p_dd_before)} → ${pct(d.p_dd_after)}
      <small>(Markov chain, p ${formatP(d.p)}${d.p < 0.05 ? (d.p_dd_after > d.p_dd_before ? ', significantly longer' : ', significantly shorter') : ''})</small></p></li>` : '';
  const a = s.aridity;
  const arid = a ? `<li><span>Desertification</span><p>UN aridity class <b>${esc(a.class_now)}</b>${a.class_now !== a.class_then ? ` (was ${esc(a.class_then)})` : ''};
      aridity index ${formatSigned(a.pct, 1)}% per decade <small>(p ${formatP(a.p)})</small>${
        a.cross ? `. At this rate it would become <b>${esc(a.towards)}</b> around <b>${a.cross}</b>.` : a.towards && a.p < 0.05 ? `, heading towards ${esc(a.towards)}.` : '.'}</p></li>` : '';
  const st = s.stability;
  const stab = st ? `<li><span>Stability</span><p><b>${num(st.score, 0)}/100</b> <small>(95% range ${num(st.low, 0)}–${num(st.high, 0)})</small>,
      rank ${fmtInt(st.rank)} of ${fmtInt(st.of)}. 100 = changing least of all sites: slow warming, steady rain, few new extremes.</p></li>` : '';
  const up = HAZARDS.map((h) => ({ h, z: s.hazards[h.id] })).filter(({ z }) => z.after > z.before && z.before > 0 && z.verdict !== 'steady')
    .sort((a, b) => b.z.after / b.z.before - a.z.after / a.z.before)[0];
  const plain = up
    ? `In plain words: ${up.h.label.toLowerCase()} now happen ${up.z.after / up.z.before >= 1.5 ? `about <b>${num(up.z.after / up.z.before, up.z.after / up.z.before >= 3 ? 0 : 1)} times as often</b>` : '<b>a bit more often</b>'} as in ${esc(early)}
       (about ${Math.round(up.z.after)} a year instead of ${Math.round(up.z.before)})${up.z.verdict === 'rising' ? ', and that is very unlikely to be luck' : ', but that could still be luck'}.`
    : 'In plain words: extreme months are <b>not</b> becoming clearly more common here.';
  return `<section class="outlook">
      <h4>Disaster outlook <span>${esc(head)}</span></h4>
      <p class="plain">${plain}</p>
      ${explain('outlook')}
      <p class="outlook-lede">${esc(lede)}${watch.length ? ` Worth watching: ${watch.map((h) => h.label.toLowerCase()).join(', ')}.` : ''}</p>
      <ul class="hazards">${rows}</ul>
      <ul class="outlook-more">${dry}${arid}${stab}</ul>
      <p class="caption">Warning signs from the record, not a forecast. Monthly data catch extreme months, not single-day storms.</p>
    </section>`;
}

/** Variable-level: how sure, extremes, emergence, years needed. */
export function deepVarHtml(core, i, v) {
  const x = core.deep?.sites?.[i]?.vars?.[v];
  if (!x) return '';
  const unit = core.variables[v].unit;
  const dec = core.variables[v].decimals;
  const dir = x.slope > 0 ? 'rising' : 'falling';
  const q = x.quantiles ?? {};
  const qv = (k) => (q[k]?.[0] === null || q[k] === undefined ? '–' : `${formatSigned(q[k][0], dec)}${q[k][1] < 0.05 ? '*' : ''}`);
  const mk = x.mk && x.mk[1] !== null
    ? ['Mann-Kendall', `${x.mk[1] < 0.05 ? `<b>${x.slope > 0 ? 'Rising' : 'Falling'} trend confirmed</b>` : 'No clear trend'} <small>(τ ${formatSigned(x.mk[0], 2)}, p ${formatP(x.mk[1])}; Sen's slope ${formatSigned(x.sen, dec)} ${esc(unit)}/decade)</small>`]
    : null;
  const rows = [
    mk,
    x.sure !== undefined && ['How sure', `<b>${pct(x.sure)}</b> sure it is ${dir} <small>(Bayesian; 95% credible ${formatSigned(x.cred?.[0], dec)} to ${formatSigned(x.cred?.[1], dec)}; Bayes factor ${num(x.bf, x.bf >= 10 ? 0 : 2)}, ${esc(x.evidence)})</small>`],
    x.quantiles && ['Extremes', `low months ${qv('10')} · typical ${qv('50')} · high months ${qv('90')} <small>${esc(unit)}/decade (* p < 0.05, quantile regression)</small>`],
    x.sn !== undefined && ['Normal range', x.emerged ? `Left its 2000s range in <b>${x.emerged}</b> <small>(signal/noise ${num(Math.abs(x.sn), 2)})</small>` : `Still within its 2000s range <small>(signal/noise ${num(Math.abs(x.sn), 2)})</small>`],
    x.sig_by && ['Not proven yet', `If it carries on at this rate, we could be sure around <b>${x.sig_by}</b>`],
  ].filter(Boolean);
  const word = (WORDS[v] ?? ['lower', 'higher'])[x.slope > 0 ? 1 : 0];
  const plain = x.p < 0.05 && x.sure > 0.99
    ? `almost certainly getting <b>${esc(word)}</b>${x.emerged ? `, and it has been outside its normal early-2000s range since <b>${x.emerged}</b>` : ''}.`
    : x.p < 0.05 ? `probably getting <b>${esc(word)}</b> (${pct(x.sure)} sure).`
    : `maybe getting ${esc(word)} (${pct(x.sure)} sure), but <b>not proven</b>${x.sig_by ? `. If it carries on, we'd know for sure around ${x.sig_by}` : ''}.`;
  return `<section class="deep">
      <h4>Deep statistics <span>${esc(core.variables[v].label)}, yearly means</span></h4>
      <p class="plain">In plain words: ${plain}</p>
      ${explain('deep')}
      <dl class="deep-list">${rows.map(([k, val]) => `<div><dt>${k}</dt><dd>${val}</dd></div>`).join('')}</dl>
    </section>`;
}

/** Briefing: planet-wide disaster tallies. */
export function briefingOutlookHtml(core) {
  const t = core.deep?.totals;
  if (!t) return '';
  const n = core.regions.length;
  const h = t.hazards_rising;
  return `<h3 class="sub">Disaster outlook <small>2012–24 vs 2000–11</small></h3>
    <dl class="brief-stats outlook-stats">
      <div><dt>Heatwave months</dt><dd>${fmtInt(h.heat)}</dd><p>sites significantly more often</p></div>
      <div><dt>Fire weather</dt><dd>${fmtInt(h.fire)}</dd><p>sites significantly more often</p></div>
      <div><dt>Very wet months</dt><dd>${fmtInt(h.flood)}</dd><p>sites significantly more often</p></div>
      <div><dt>Dry-soil months</dt><dd>${fmtInt(h.drought)}</dd><p>sites significantly more often</p></div>
    </dl>
    <p class="caption">${fmtInt(t.any_hazard_rising)} of ${fmtInt(n)} sites have at least one hazard rising; dry spells are significantly longer at ${fmtInt(t.longer_dry_spells)};
      ${fmtInt(t.aridity_crossing)} are on course to cross into a drier UN aridity class. Corrected for testing every site and hazard.</p>`;
}

/** Methods text for the provenance drawer. */
export function deepMethodsHtml(core) {
  const m = core.deep?.methods;
  if (!m) return '';
  const names = { mann_kendall: 'Mann-Kendall', bayes: 'How sure', extremes: 'Extremes', emergence: 'Normal range', years_needed: 'Not proven yet', hazards: 'Disaster outlook',
    dry_spells: 'Dry spells', aridity: 'Desertification', stability: 'Stability' };
  return Object.entries(m).map(([k, t]) => `<p><b>${esc(names[k] ?? k)}.</b> ${esc(t)}</p>`).join('');
}
