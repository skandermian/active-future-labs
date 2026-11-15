import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchLive } from '../src/ui/live.js';

const reply = (status, body) => ({ ok: status < 400, status, json: async () => body });

test('a waking / overloaded server (503) is retried once automatically', async () => {
  let calls = 0;
  const f = async () => (++calls === 1 ? reply(503, { detail: 'NASA POWER did not answer' }) : reply(200, { ok: 1 }));
  assert.deepEqual(await fetchLive({ lat: 13.5, lon: 2.1 }, f), { ok: 1 });
  assert.equal(calls, 2);
});

test('"this is ocean" (422) is shown straight away, not retried', async () => {
  let calls = 0;
  const f = async () => { calls++; return reply(422, { detail: 'NASA has no land data here' }); };
  await assert.rejects(fetchLive({ lat: 0, lon: -30 }, f), /no land data/);
  assert.equal(calls, 1);
});
