import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTrendDataSource } from '../src/sources/trendData.js';

test('a failed download is retried and never cached', async () => {
  let calls = 0;
  const flaky = async () => { calls += 1; if (calls <= 2) throw new TypeError('Failed to fetch'); return { ok: calls }; };
  const src = createTrendDataSource({ baseUrl: '/data/', fetchJson: flaky });
  assert.deepEqual(await src.monthly('T2M'), { ok: 3 });      // succeeded on the 3rd try
  let n = 0;
  const down = async () => { n += 1; throw new TypeError('Failed to fetch'); };
  const src2 = createTrendDataSource({ baseUrl: '/data/', fetchJson: down });
  await assert.rejects(src2.monthly('T2M'));
  await assert.rejects(src2.monthly('T2M'));
  assert.equal(n, 6);                                           // tried again on the next click, not stuck
});
