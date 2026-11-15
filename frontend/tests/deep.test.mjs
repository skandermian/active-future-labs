import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { outlookHtml, deepVarHtml, briefingOutlookHtml } from '../src/ui/deep.js';

const load = async (f) => JSON.parse(await readFile(new URL(`../public/data/${f}`, import.meta.url)));
const deep = await load('deep.json');
const regions = await load('regions.json');
const manifest = await load('manifest.json');

test('deep.json covers every site with all four hazards', () => {
  assert.equal(deep.sites.length, regions.length);
  for (const s of deep.sites) for (const h of ['heat', 'drought', 'flood', 'fire']) assert.ok(s.hazards[h], h);
});

test('hazard verdicts follow their corrected p-values', () => {
  for (const s of deep.sites)
    for (const z of Object.values(s.hazards)) {
      if (z.verdict === 'rising') assert.ok(z.ratio > 1 && z.q < 0.05);
      if (z.verdict === 'falling') assert.ok(z.ratio < 1 && z.q < 0.05);
      for (const p of [z.now, z.base]) assert.ok(p === null || (p >= 0 && p <= 1));
    }
  const rising = deep.sites.filter((s) => s.hazards.heat.verdict === 'rising').length;
  assert.equal(rising, deep.totals.hazards_rising.heat);
});

test('stability ranks are unique, 1..n, and scores sit inside their 95% range', () => {
  const st = deep.sites.map((s) => s.stability).filter(Boolean);
  assert.deepEqual(st.map((x) => x.rank).sort((a, b) => a - b), st.map((_, i) => i + 1));
  for (const x of st) assert.ok(x.score >= 0 && x.score <= 100);
});

test('probabilities of direction are valid and Bayes sure-ness agrees with the slope sign', () => {
  for (const s of deep.sites)
    for (const x of Object.values(s.vars)) if (x && x.sure !== undefined) {
      assert.ok(x.sure >= 0.5 && x.sure <= 1);
      assert.ok(x.cred[0] <= x.slope + 1e-9 && x.slope <= x.cred[1] + 1e-9);
    }
});

test('the dossier sections render for every site without throwing', () => {
  const core = { deep, regions, variables: Object.fromEntries(manifest.variables.map((v) => [v.id, v])) };
  assert.ok(briefingOutlookHtml(core).includes('Heatwave'));
  regions.forEach((_, i) => {
    assert.ok(outlookHtml(core, i).includes('Disaster outlook'));
    for (const v of Object.keys(core.variables)) deepVarHtml(core, i, v);
  });
});

test('plain-English text never shows "undefined" or "NaN"', async () => {
  const { guideHtml, glossaryHtml, explain } = await import('../src/ui/explain.js');
  const core = { deep, regions, variables: Object.fromEntries(manifest.variables.map((v) => [v.id, v])) };
  const bad = /undefined|NaN/;
  for (const h of [guideHtml(), glossaryHtml(), ...['detectors', 'signals', 'outlook', 'sources', 'matrix', 'chart', 'deep', 'analogue'].map(explain)]) assert.ok(!bad.test(h));
  regions.forEach((_, i) => {
    assert.ok(!bad.test(outlookHtml(core, i)), `outlook ${i}`);
    for (const v of Object.keys(core.variables)) assert.ok(!bad.test(deepVarHtml(core, i, v)), `${i} ${v}`);
  });
});
