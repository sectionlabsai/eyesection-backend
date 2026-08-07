import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregate } from './gpt.service';

test('aggregate averages the ensemble into 0..1 severities', () => {
  const out = aggregate([
    { puffiness: 20, tiredLook: 60, darkCircles: 40, redness: 0, fineLines: 30, dullness: 50 },
    { puffiness: 30, tiredLook: 66, darkCircles: 44, redness: 0, fineLines: 36, dullness: 56 },
    { puffiness: 25, tiredLook: 63, darkCircles: 42, redness: 0, fineLines: 33, dullness: 53 },
  ]);
  assert.ok(Math.abs(out.tiredLook - 0.63) < 1e-9);
  assert.ok(Math.abs(out.redness - 0) < 1e-9);
  assert.ok(Math.abs(out.fineLines - 0.33) < 1e-9);
  assert.ok(Math.abs(out.dullness - 0.53) < 1e-9);
  assert.equal(out.source, 'gpt');
});

test('aggregate reports high confidence when samples agree, low when they scatter', () => {
  const tight = aggregate([
    { puffiness: 40, tiredLook: 40, darkCircles: 40, redness: 40, fineLines: 40, dullness: 40 },
    { puffiness: 41, tiredLook: 39, darkCircles: 40, redness: 40, fineLines: 41, dullness: 39 },
    { puffiness: 40, tiredLook: 40, darkCircles: 41, redness: 39, fineLines: 40, dullness: 40 },
  ]);
  const scattered = aggregate([
    { puffiness: 10, tiredLook: 80, darkCircles: 5, redness: 90, fineLines: 5, dullness: 85 },
    { puffiness: 70, tiredLook: 10, darkCircles: 95, redness: 5, fineLines: 90, dullness: 10 },
    { puffiness: 40, tiredLook: 45, darkCircles: 50, redness: 50, fineLines: 45, dullness: 50 },
  ]);
  assert.ok(tight.confidence > 0.9, `tight ${tight.confidence}`);
  assert.ok(scattered.confidence < 0.4, `scattered ${scattered.confidence}`);
});

test('aggregate caps confidence for a single un-cross-checked sample', () => {
  const out = aggregate([
    { puffiness: 40, tiredLook: 40, darkCircles: 40, redness: 40, fineLines: 40, dullness: 40 },
  ]);
  assert.ok(out.confidence <= 0.5);
});
