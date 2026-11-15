import { defineTool } from './catalog.js';
import { trendRecord } from '../sources/trendData.js';
import { poleWords } from '../layers/colorScale.js';
import { formatSigned } from '../ui/format.js';

/** Biggest significant changes for one variable, both directions. */
export const rankChanges = defineTool({
  name: 'rank_changes',
  description: 'Places with the largest significant change for a variable, split into increases and decreases.',
  async run({ variable, limit = 5 }, { source }) {
    const core = await source.loadCore();
    if (!core.variables[variable]) throw new Error(`Unknown variable ${variable}`);
    const recs = core.regions
      .map((_, i) => trendRecord(core, i, variable))
      .filter((r) => r.available && r.verdict === 'significant');
    const byStandardised = (a, b) => Math.abs(b.slope) - Math.abs(a.slope);
    const up = recs.filter((r) => r.slope > 0).sort(byStandardised).slice(0, limit);
    const down = recs.filter((r) => r.slope < 0).sort(byStandardised).slice(0, limit);
    const v = core.variables[variable];
    const [lowWord, highWord] = poleWords(variable);
    const total = recs.length;
    return {
      summary: `${total} of ${core.regions.length} places show a significant change in ${v.label.toLowerCase()}: ` +
        `${recs.filter((r) => r.slope > 0).length} ${highWord}, ${recs.filter((r) => r.slope < 0).length} ${lowWord}.`,
      data: { variable, up, down, significantCount: total },
    };
  },
});

/** Every variable at one place: the place's "fingerprint" of change. */
export const regionFingerprint = defineTool({
  name: 'region_fingerprint',
  description: 'All ten variables at one place: direction, size and evidence of change.',
  async run({ regionIndex }, { source }) {
    const core = await source.loadCore();
    const region = core.regions[regionIndex];
    if (!region) throw new Error(`Unknown region index ${regionIndex}`);
    const rows = Object.keys(core.variables).map((variable) => trendRecord(core, regionIndex, variable));
    const sig = rows.filter((r) => r.verdict === 'significant');
    return {
      summary: sig.length
        ? `${region.name}: ${sig.length} of ${rows.length} variables changed significantly — ` +
          sig.map((r) => `${r.variable.label.toLowerCase()} ${formatSigned(r.slope, r.variable.decimals)} ${r.variable.unit}/decade`).join('; ') + '.'
        : `${region.name}: no variable changed significantly between 2000 and 2024.`,
      data: { region, rows },
    };
  },
});

/** Most unusual places in one year, relative to each place's own normal. */
export const rankAnomalies = defineTool({
  name: 'rank_anomalies',
  description: 'Places furthest above and below their own 2000-2024 normal in a given year.',
  async run({ variable, year, limit = 5 }, { source }) {
    const core = await source.loadCore();
    const v = core.variables[variable];
    if (!v) throw new Error(`Unknown variable ${variable}`);
    const annual = await source.annual(variable);
    const j = annual.years.indexOf(year);
    if (j < 0) throw new Error(`No data for ${year}`);
    const rows = core.regions
      .map((region, regionIndex) => ({ region, regionIndex, value: annual.values[regionIndex][j], scale: annual.scale }))
      .filter((r) => r.value !== null && r.value !== undefined);
    const above = rows.filter((r) => r.value > 0).sort((a, b) => b.value - a.value).slice(0, limit);
    const below = rows.filter((r) => r.value < 0).sort((a, b) => a.value - b.value).slice(0, limit);
    return {
      summary: `In ${year}, ${rows.filter((r) => r.value > 0).length} places had above-normal ${v.label.toLowerCase()} ` +
        `and ${rows.filter((r) => r.value < 0).length} below normal. One unusual year is weather, not a trend.`,
      data: { variable, year, above, below },
    };
  },
});

export const CORE_TOOLS = [rankChanges, regionFingerprint, rankAnomalies];
