import { colorForChange, evidenceAlpha, legendGradient, poleWords } from '../layers/colorScale.js';
import { trendRecord } from '../sources/trendData.js';
import { formatNumber } from '../ui/format.js';

/** Lens 1: how much has each place changed per decade, and is it real? */
export function createTrendLens() {
  let core = null;
  let variable = null;

  return {
    id: 'trend',
    label: 'Change',
    question: 'What changed between 2000 and 2024, and is it significant?',
    usesTimeline: false,

    async prepare(ctx) {
      core = ctx.core;
      variable = ctx.state.variable;
    },

    paint(index) {
      const rec = trendRecord(core, index, variable);
      if (!rec?.available) return null;
      return { rgb: colorForChange(rec.slope, rec.scale, variable), alpha: evidenceAlpha(rec.verdict) };
    },

    legend() {
      const v = core.variables[variable];
      const scale = core.trends.variables[variable].scale;
      const [low, high] = poleWords(variable);
      return {
        gradient: legendGradient(variable),
        left: `−${formatNumber(scale, v.decimals)}`,
        right: `+${formatNumber(scale, v.decimals)}`,
        unit: `${v.unit} per decade`,
        poles: [low, high],
        note: `Solid = significant after correcting for ${core.trends.n_tests.toLocaleString('en-GB')} tests · faint = could be chance`,
      };
    },
  };
}
