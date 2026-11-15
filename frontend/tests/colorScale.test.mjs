import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diverging, colorForChange, polarity, evidenceAlpha, hexToOklab, NEUTRAL } from '../src/layers/colorScale.js';

const L = ([r, g, b]) => hexToOklab('#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join(''))[0];

test('midpoint is the neutral grey', () => {
  assert.deepEqual(diverging(0), [0x4d, 0x4d, 0x4b]);
  assert.equal(NEUTRAL, '#4d4d4b');
});

test('lightness rises monotonically away from zero on both arms', () => {
  for (const sign of [-1, 1]) {
    let prev = -Infinity;
    for (let k = 0; k <= 20; k++) {
      const l = L(diverging((sign * k) / 20));
      assert.ok(l >= prev - 1e-6, `arm ${sign} step ${k}`);
      prev = l;
    }
  }
});

test('warming is red and wetting is blue', () => {
  const [r1, , b1] = colorForChange(1, 1, 'T2M');
  assert.ok(r1 > b1);
  const [r2, , b2] = colorForChange(1, 1, 'gpm_rain');
  assert.ok(b2 > r2);
  assert.equal(polarity('T2M'), 1);
  assert.equal(polarity('soil_moisture'), -1);
});

test('values beyond the scale clamp; missing values give no colour', () => {
  assert.deepEqual(diverging(5), diverging(1));
  assert.equal(colorForChange(null, 1, 'T2M'), null);
});

test('evidence alpha orders significant > suggestive > not significant', () => {
  assert.ok(evidenceAlpha('significant') > evidenceAlpha('suggestive'));
  assert.ok(evidenceAlpha('suggestive') > evidenceAlpha('not_significant'));
  assert.equal(evidenceAlpha('no_data'), 0);
});
