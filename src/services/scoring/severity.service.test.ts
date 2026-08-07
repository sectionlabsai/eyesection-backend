import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  severityFromValue,
  levelFromSeverity,
  blendSeverity,
  gptWeightFromConfidence,
  severityToSubScore,
} from './severity.service';

const CUTOFFS: [number, number, number] = [4, 9, 15];

test('severityFromValue is continuous and monotonic across the range', () => {
  assert.equal(severityFromValue(0, CUTOFFS), 0);
  const a = severityFromValue(5, CUTOFFS);
  const b = severityFromValue(8, CUTOFFS);
  const c = severityFromValue(14, CUTOFFS);
  assert.ok(a < b && b < c, 'severity must increase with the measured value');
  // Two nearby values give genuinely different severities (no bucket collapse).
  assert.notEqual(severityFromValue(6, CUTOFFS), severityFromValue(8, CUTOFFS));
  assert.ok(severityFromValue(100, CUTOFFS) <= 1);
});

test('levelFromSeverity uses the midpoints of the severity anchors', () => {
  assert.equal(levelFromSeverity(0.1), 'none');
  assert.equal(levelFromSeverity(0.3), 'mild');
  assert.equal(levelFromSeverity(0.6), 'moderate');
  assert.equal(levelFromSeverity(0.9), 'high');
});

test('gptWeightFromConfidence ignores low agreement and ramps trust with it', () => {
  assert.equal(gptWeightFromConfidence(0.5), 0); // below the trust floor
  assert.ok(Math.abs(gptWeightFromConfidence(0.6) - 0.4) < 1e-9);
  assert.ok(Math.abs(gptWeightFromConfidence(1.0) - 0.8) < 1e-9);
});

test('blendSeverity lets a confident model pull the code severity toward its read', () => {
  // Code reads low (0.4), a confident ensemble reads higher (0.66).
  const pulled = blendSeverity(0.4, 0.66, gptWeightFromConfidence(1.0));
  assert.ok(pulled > 0.4 && pulled <= 0.66);
  // With zero weight the code severity is untouched.
  assert.equal(blendSeverity(0.4, 1.0, 0), 0.4);
});

test('severityToSubScore inverts severity into a 0..100 freshness sub-score', () => {
  assert.equal(severityToSubScore(0), 100);
  assert.equal(severityToSubScore(1), 0);
  assert.equal(severityToSubScore(0.25), 75);
});
