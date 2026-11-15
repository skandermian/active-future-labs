import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createTrendDataSource, trendRecord } from '../src/sources/trendData.js';
import { composeCatalog } from '../src/tools/catalog.js';
import { CORE_TOOLS } from '../src/tools/queries.js';
import { verdictSentence } from '../src/ui/format.js';
import { poleWords } from '../src/layers/colorScale.js';

const dataDir = new URL('../public/data/', import.meta.url);
const source = createTrendDataSource({
  baseUrl: dataDir.href,
  fetchJson: async (u) => JSON.parse(await readFile(new URL(u))),
});
const tools = composeCatalog(CORE_TOOLS, { source });

test('exported data is internally consistent', async () => {
  const core = await source.loadCore();
  assert.equal(core.regions.length, core.manifest.regions);
  for (const [id, t] of Object.entries(core.trends.variables)) {
    assert.equal(t.slope.length, core.regions.length, id);
    t.slope.forEach((s, i) => {
      if (s === null) return;
      assert.ok(t.ci_low[i] <= s && s <= t.ci_high[i], `${id} CI brackets slope at ${i}`);
      if (t.verdict[i] === 'significant') assert.ok(t.p_bh[i] < 0.05);
    });
  }
  const fitted = Object.values(core.trends.variables).reduce((n, t) => n + t.slope.filter((s) => s !== null).length, 0);
  assert.equal(fitted, core.trends.n_tests);
});

test('rank_changes returns only significant results, largest first', async () => {
  const { data, summary } = await tools.call('rank_changes', { variable: 'T2M', limit: 5 });
  assert.match(summary, /places show a significant change/);
  assert.ok(data.up.length > 0);
  for (const list of [data.up, data.down]) {
    list.forEach((r) => assert.equal(r.verdict, 'significant'));
    for (let i = 1; i < list.length; i++) assert.ok(Math.abs(list[i - 1].slope) >= Math.abs(list[i].slope));
  }
});

test('region_fingerprint covers all ten variables', async () => {
  const { data } = await tools.call('region_fingerprint', { regionIndex: 0 });
  assert.equal(data.rows.length, 10);
  assert.equal(data.region.name, 'Central Amazon');
});

test('verdict sentences match the evidence', async () => {
  const core = await source.loadCore();
  const rec = trendRecord(core, 0, 'T2M');
  const text = verdictSentence(rec, poleWords('T2M'), core.trends.n_tests);
  assert.ok(text.length > 20);
  if (rec.verdict === 'significant') assert.match(text, /very unlikely to be chance/);
});

test('unknown tools and variables are rejected', async () => {
  await assert.rejects(tools.call('nope'));
  await assert.rejects(tools.call('rank_changes', { variable: 'XYZ' }));
});

test('rank_anomalies orders by distance from normal for the chosen year', async () => {
  const { data } = await tools.call('rank_anomalies', { variable: 'T2M', year: 2010, limit: 5 });
  assert.equal(data.year, 2010);
  for (let i = 1; i < data.above.length; i++) assert.ok(data.above[i - 1].value >= data.above[i].value);
  for (let i = 1; i < data.below.length; i++) assert.ok(data.below[i - 1].value <= data.below[i].value);
  await assert.rejects(tools.call('rank_anomalies', { variable: 'T2M', year: 1990 }));
});
