import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { filterSignals, siteLead, signalIndex, SIGNAL_TYPES, siteCode } from '../src/intel/signals.js';

const load = async (f) => JSON.parse(await readFile(new URL(`../public/data/${f}`, import.meta.url)));
const intel = await load('intel.json');
const regions = await load('regions.json');
const trends = await load('trends.json');

test('every signal points at a real site, has a known type, and is ranked by score', () => {
  let prev = Infinity;
  for (const s of intel.signals) {
    assert.ok(regions[s.site], s.id);
    assert.ok(SIGNAL_TYPES[s.type], s.type);
    assert.ok(s.score <= prev + 1e-9, `${s.id} out of order`);
    prev = s.score;
  }
});

test('drift signals only come from trends the backend marked significant', () => {
  for (const s of intel.signals.filter((x) => x.type === 'drift')) {
    const t = trends.variables[s.var];
    assert.equal(t.verdict[s.site], 'significant', s.id);
  }
});

test('contradicted conflicts are both significant with opposite signs', () => {
  for (const s of intel.signals.filter((x) => x.type === 'conflict' && x.state === 'contradicted')) {
    const [a, b] = s.pair;
    assert.equal(trends.variables[a].verdict[s.site], 'significant');
    assert.equal(trends.variables[b].verdict[s.site], 'significant');
    assert.ok(Math.sign(s.slopes[0]) !== Math.sign(s.slopes[1]), s.id);
  }
});

test('migration never points a site at itself and site names are unique', () => {
  for (const s of intel.signals.filter((x) => x.type === 'migrate')) assert.notEqual(s.site, s.target);
  assert.equal(new Set(regions.map((r) => r.name)).size, regions.length);
});

test('no early-warning finding is claimed when none survived correction', () => {
  assert.equal(intel.detectors.resilience.count, 0);
  assert.ok(!intel.signals.some((s) => s.type === 'resilience'));
});

test('site lists and ranks are consistent', () => {
  const ranks = intel.sites.map((s) => s.rank).sort((a, b) => a - b);
  assert.deepEqual(ranks, regions.map((_, i) => i + 1));
  const idx = signalIndex(intel);
  intel.sites.forEach((site, i) => site.signals.forEach((id) => assert.equal(idx.get(id).site, i)));
});

test('filters and search narrow the feed', () => {
  const conflicts = filterSignals(intel, regions, { type: 'conflict' });
  assert.ok(conflicts.length > 0 && conflicts.every((s) => s.type === 'conflict'));
  const amazon = filterSignals(intel, regions, { query: 'brazil' });
  assert.ok(amazon.length > 0 && amazon.every((s) => /brazil/i.test(regions[s.site].country + regions[s.site].name + s.headline)));
  assert.equal(siteLead(intel, 0, 'conflict')?.type ?? 'conflict', 'conflict');
  assert.equal(siteCode(regions[0]), '0001');
});
