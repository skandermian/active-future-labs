import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { liveHtml, liveChartInput } from '../src/ui/live.js';

const sample = JSON.parse(await readFile(new URL('./fixtures/live_sample.json', import.meta.url)));

test('the live panel shows every variable, the Mann-Kendall column and the outlook', () => {
  const html = liveHtml({ status: 'ready', radius: 0, data: sample }, {}, 'T2M');
  for (const v of Object.keys(sample.variables)) assert.ok(html.includes(`data-live-var="${v}"`), v);
  assert.ok(html.includes('Mann-Kendall p') && html.includes('Disaster outlook') && html.includes('In plain words'));
  assert.ok(!/undefined|NaN/.test(html));
  assert.ok(html.includes('1981–2002'));
});

test('loading and error states explain themselves', () => {
  assert.ok(liveHtml({ status: 'loading', radius: 100 }, {}, 'T2M').includes('100 km area'));
  assert.ok(liveHtml({ status: 'error', radius: 0, message: 'NASA POWER did not answer.' }, {}, 'T2M').includes('nearest analysed area'));
});

test('chart input has 44 yearly points for a live variable', () => {
  const c = liveChartInput(sample, 'T2M');
  assert.equal(c.startYear, 1981);
  assert.equal(c.years.length, 44);
  assert.ok(c.rec.available && Number.isFinite(c.rec.slope));
});
