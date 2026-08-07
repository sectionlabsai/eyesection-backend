import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeFreshness, FRESHNESS_WEIGHTS, SubScores } from './freshness.service';

const base: SubScores = {
  darkCircles: 70,
  puffiness: 70,
  tiredLook: 70,
  redness: 70,
  fineLines: 70,
  radiance: 70,
  symmetry: 70,
};

test('freshness weights cover all seven metrics and sum to 1', () => {
  const keys = Object.keys(FRESHNESS_WEIGHTS).sort();
  assert.deepEqual(keys, [
    'darkCircles',
    'fineLines',
    'puffiness',
    'radiance',
    'redness',
    'symmetry',
    'tiredLook',
  ]);
  const sum = Object.values(FRESHNESS_WEIGHTS).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, `weights sum ${sum}`);
});

test('a uniform sub-score profile scores at that value', () => {
  assert.equal(computeFreshness(base).freshnessScore, 70);
});

test('the new metrics genuinely move the score (no bucket collapse)', () => {
  const smooth = computeFreshness({ ...base, fineLines: 95, radiance: 95 });
  const rough = computeFreshness({ ...base, fineLines: 20, radiance: 20 });
  assert.ok(smooth.freshnessScore > rough.freshnessScore, 'fine lines + radiance must affect the score');
  // Weighted contribution of the two skin-quality metrics is 17% of the range.
  assert.ok(smooth.freshnessScore - rough.freshnessScore >= 10);
});
