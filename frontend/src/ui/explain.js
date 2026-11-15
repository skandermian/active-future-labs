/**
 * Plain-English layer: a how-to-read guide, a glossary, a "What does this mean?"
 * drop-down for every section, and one-sentence takeaways anyone can read.
 * Pure HTML builders; native <details> so it works without extra JavaScript.
 */
import { esc } from './dom.js';
import { formatSigned } from './format.js';

export const WORDS = {
  T2M: ['cooler', 'warmer'], RH2M: ['drier air', 'more humid air'], aerosol: ['clearer air', 'hazier air'], dust: ['less dust', 'more dust'],
  PRECTOTCORR: ['less rain', 'more rain'], gpm_rain: ['less rain', 'more rain'], evaporation: ['less evaporation', 'more evaporation'],
  runoff: ['less runoff', 'more runoff'], GWETTOP: ['drier topsoil', 'wetter topsoil'], soil_moisture: ['drier soil', 'wetter soil'],
};

const EXPLAIN = {
  detectors: `The computer checked every place for five kinds of change. Tap one to show only that kind on the globe and in the list.
    <ul>
      <li><b>▲ Drift</b>: the normal level is moving, e.g. the place is getting warmer or rainier year after year.</li>
      <li><b>≈ Erratic</b>: the ups and downs are getting bigger, so weather is less predictable.</li>
      <li><b>∼ Steadier</b>: the ups and downs are getting smaller.</li>
      <li><b>✕ Conflict</b>: two NASA records of the same thing (e.g. rain from a model and from satellites) disagree, so be careful.</li>
      <li><b>→ Migrate</b>: this place's recent climate now looks like another place's climate 20 years ago.</li>
    </ul>
    <b>Confirmed</b> = very strong evidence or two NASA records agree. <b>Probable</b> = strong evidence from one record. <b>Lead</b> = worth a look, not proven.`,
  signals: `Each line is one change the computer found here, written as a headline. <b>Confirmed</b> means very strong evidence, or a second NASA record agrees.
    <b>Probable</b> means strong evidence from one record. Tap a line to draw its chart below.`,
  outlook: `We count "extreme months": months far outside what was normal for that time of year in 2000–2011 (e.g. a July hotter than 9 in 10 Julys back then).
    Then we check if they happen more often in 2012–2024. <b>Rising</b> = clearly more often, and not just luck, even after checking all 360 places.
    <b>Watch</b> = more often, but it could still be luck. <b>"Now X% of months"</b> is the chance that any month today is extreme here.
    These are warning signs from the past, not a weather forecast.`,
  sources: `NASA measures some things in two independent ways, such as rain from a computer model and rain from satellites. If both agree, we trust the result more.
    If they disagree, nobody should rely on a trend from only one of them.`,
  matrix: `One row per thing NASA measures. <b>Average</b> = how much the normal level changes every 10 years. <b>Swings</b> = whether the ups and downs grow (+) or shrink (−), in % per 10 years.
    <b>Memory</b> = whether each month looks more like the one before (a possible early-warning sign). Bright numbers are proven, after checking all places; grey ones could be luck.`,
  chart: `The thin line shows each month compared with what is normal for that month here (0 = normal). The dots are yearly averages.
    The straight line is the trend, and the shaded fan is how sure we are of it: if the fan is all above or all below 0, the change is real.`,
  deep: `Extra checks on the chart above. <b>How sure</b>: the chance that it is really going up (or down), not just random weather.
    <b>Extremes</b>: whether the lowest, typical and highest months are changing at different speeds. <b>Normal range</b>: the year it moved outside its
    usual early-2000s ups and downs. <b>Not proven yet</b>: how long we would need to keep measuring before we could be sure.`,
  analogue: `We compared this place's climate in 2020–24 with every place's climate in 2000–04. The closest match is shown: it is as if this place's climate has "moved".
    Treat it as a clue, not proof: some matches happen by chance.`,
};

export function explain(key) {
  return EXPLAIN[key] ? `<details class="explain"><summary>What does this mean?</summary><div>${EXPLAIN[key]}</div></details>` : '';
}

export function guideHtml() {
  return `<details class="guide" open>
      <summary>New here? How to read this in 1 minute</summary>
      <ol>
        <li><b>Each dot on the globe is a place</b> (360 of them). NASA satellites and computer models have measured them every month since 2000: temperature, rain, soil, haze and more.</li>
        <li><b>The computer looks for real change</b>, not just one odd year. A change only counts if it is very unlikely to be luck, even after checking all 3,545 place-and-measurement pairs.</li>
        <li><b>Tap any dot</b> to open its case file: what is changing, how sure we are, and its disaster outlook (heatwaves, droughts, floods, fire weather).</li>
        <li><b>Stuck on a word?</b> Every section has a "What does this mean?" button, and the full word list is at the bottom of this page.</li>
      </ol>
    </details>`;
}

const GLOSSARY = [
  ['Trend', 'The overall direction over many years, ignoring the ups and downs. "+0.3 °C per decade" means about 0.3 °C warmer every 10 years.'],
  ['Decade', '10 years.'],
  ['Significant / proven', 'So unlikely to happen by chance that we treat it as real. We use the usual science rule: less than a 1 in 20 chance of being luck.'],
  ['p-value (p)', 'The chance of seeing a change this big if nothing were really changing. Small p (below 0.05) = probably real.'],
  ['q-value (q)', 'A p-value made stricter because we tested many places at once. With 360 places, some would look "significant" by luck; q fixes that.'],
  ['How sure (%)', 'Bayesian probability that the trend really goes the way the data shows. 50% = a coin toss; above 99% = almost certain.'],
  ['Bayes factor', 'How many times more the data supports "changing" than "not changing". Above 3 = some evidence, above 20 = strong, below 1 = favours no change.'],
  ['95% range / credible range', 'Where the true value very probably lies. A narrow range = we know it well.'],
  ['Extreme month', 'A month far outside what was normal for that time of year in 2000–2011 (beyond 9 in 10 of those years).'],
  ['Fire weather', 'Months that are both unusually hot and have unusually dry air: the conditions that let wildfires spread, wherever there is something to burn.'],
  ['Dry spell', 'A run of months in a row with less rain than normal. Longer dry spells stress crops, forests and water supplies.'],
  ['Aridity / desertification', 'How dry a place is: the rain it gets compared with how much water the sun and heat could evaporate. The UN groups places from Humid to Hyper-arid (desert).'],
  ['Stability score', '0–100: how little this place is changing compared with all 360. High = slow warming, steady rain and few new extremes, a safer long-term bet.'],
  ['Normal range / signal-to-noise', 'Every place has natural ups and downs ("noise"). When the long-term change ("signal") gets bigger than those, the climate has left its normal range.'],
  ['Swings', 'How far months typically go above or below normal. Bigger swings = less predictable weather.'],
  ['Reanalysis model (MERRA-2, GLDAS)', 'NASA computer models that combine millions of real measurements with physics to fill in the whole planet, every month.'],
  ['Satellite (GPM IMERG)', 'Rain measured from space by a team of satellites. Used to double-check the model.'],
  ['AOD (haze)', 'Aerosol optical depth: how much dust, smoke and pollution dims sunlight. 0 = perfectly clear; above 0.5 = very hazy.'],
];

export function glossaryHtml() {
  return `<details class="glossary">
      <summary>What do these words mean?</summary>
      <dl>${GLOSSARY.map(([t, d]) => `<div><dt>${esc(t)}</dt><dd>${esc(d)}</dd></div>`).join('')}</dl>
    </details>`;
}

/** One sentence for the chart: what, how much, how sure. */
export function chartTakeaway(rec, vId) {
  if (!rec?.available) return 'Not enough reliable data here to test for a trend.';
  const [down, up] = WORDS[vId] ?? ['lower', 'higher'];
  const dir = rec.slope > 0 ? up : down;
  const amount = `${formatSigned(rec.slope, rec.variable.decimals)} ${rec.variable.unit} every 10 years`;
  if (rec.verdict === 'significant') return `In plain words: this place is getting <b>${esc(dir)}</b> (${esc(amount)}), and it is very unlikely to be luck.`;
  if (rec.verdict === 'suggestive') return `In plain words: it might be getting ${esc(dir)} (${esc(amount)}), but it isn't proven yet.`;
  return `In plain words: <b>no clear change</b>. The small trend (${esc(amount)}) could easily be normal ups and downs.`;
}
