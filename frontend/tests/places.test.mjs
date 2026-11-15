import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { distanceKm, nearestSite, localMatch, parseCoords, findPlace } from '../src/tools/places.js';

const regions = JSON.parse(await readFile(new URL('../public/data/regions.json', import.meta.url)));

test('distances are right (London to Manchester about 262 km)', () => {
  assert.ok(Math.abs(distanceKm(51.507, -0.128, 53.48, -2.24) - 262) < 5);
});

test('any point maps to its nearest site, and a site maps to itself', () => {
  regions.forEach((r, i) => assert.equal(nearestSite(regions, r.lat, r.lon).index, i));
  const m = nearestSite(regions, 53.48, -2.24);
  assert.ok(m.index >= 0 && m.km < 400);
});

test('names, towns and coordinates are recognised', () => {
  assert.equal(regions[localMatch(regions, 'london')].name, 'London');
  assert.deepEqual(parseCoords('53.48, -2.24'), { lat: 53.48, lon: -2.24 });
  assert.equal(parseCoords('Manchester'), null);
  assert.equal(parseCoords('95, 10'), null);
});

test('search uses OpenStreetMap for unknown towns and falls back offline', async () => {
  const fake = async () => ({ ok: true, json: async () => [{ display_name: 'Manchester, Greater Manchester, England, United Kingdom', lat: '53.48', lon: '-2.24' }] });
  const p = await findPlace(regions, 'Manchester', fake);
  assert.equal(p.label, 'Manchester, United Kingdom');
  const offline = async () => { throw new Error('offline'); };
  const q = await findPlace(regions, 'Lond', offline);
  assert.equal(regions[q.site].name, 'London');
  assert.equal(await findPlace(regions, 'zzzzqqq', offline), null);
});
