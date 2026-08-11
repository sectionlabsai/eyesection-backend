import { test } from 'node:test';
import assert from 'node:assert/strict';
import { averageRgb, dominantIrisHsl } from './color';

/** Build an RGB buffer from a list of [r,g,b] pixels. */
function pixels(...px: Array<[number, number, number]>): Buffer {
  return Buffer.from(px.flat());
}

test('averageRgb trims luminance outliers before averaging', () => {
  // Eight mid-brown pixels plus one near-black and one near-white outlier.
  const brown: [number, number, number] = [150, 100, 80];
  const buf = pixels([2, 2, 2], ...Array(8).fill(brown), [253, 253, 253]);

  const plain = averageRgb(buf, 3);
  const trimmed = averageRgb(buf, 3, { trim: 0.1 });

  // The trimmed mean drops both outliers and lands on the true region colour.
  assert.equal(Math.round(trimmed.r), 150);
  assert.equal(Math.round(trimmed.g), 100);
  assert.equal(Math.round(trimmed.b), 80);
  // The plain mean is pulled off by the outliers.
  assert.notEqual(Math.round(plain.g), 100);
});

test('averageRgb skipScleraLike drops bright desaturated pixels but keeps grey iris tones', () => {
  const sclera: [number, number, number] = [225, 222, 220]; // bright, low sat
  const greyIris: [number, number, number] = [120, 122, 128]; // mid-lightness grey

  const out = averageRgb(pixels(sclera, sclera, sclera, greyIris), 3, {
    skipScleraLike: true,
  });
  assert.equal(out.count, 1);
  assert.equal(Math.round(out.b), 128);
});

test('averageRgb returns count 0 when every pixel is filtered', () => {
  const out = averageRgb(pixels([10, 10, 10]), 3, { skipDark: 35 });
  assert.equal(out.count, 0);
});

test('dominantIrisHsl recovers the iris hue past pupil and neutral pixels', () => {
  const buf = pixels(
    [30, 30, 30], [30, 30, 30], [30, 30, 30], // pupil — excluded by skipDark
    [100, 100, 100], [100, 100, 100], [100, 100, 100], // neutral survivors, no colour
    [120, 80, 50], [120, 80, 50], [120, 80, 50], [120, 80, 50], // warm brown iris
  );
  const s = dominantIrisHsl(buf, 3, { skipDark: 55, skipBright: 235, minChroma: 0.1 });
  assert.ok(s);
  // Warm brown hue (~26°), not dragged toward the neutral mean.
  assert.ok(s.h > 10 && s.h < 45, `hue ${s.h} should be warm`);
  // 4 chromatic of 7 survivors (pupil excluded).
  assert.ok(Math.abs(s.chromaticFraction - 4 / 7) < 1e-6);
});

test('dominantIrisHsl keeps a brown iris warm despite a saturated cool reflection', () => {
  // A brown iris is many faintly-warm pixels; a screen/window glint is a few
  // strongly-saturated blue pixels. A saturation-weighted circular mean gets
  // dragged cool by the glint; the count-based dominant cluster does not.
  const warm: [number, number, number] = [118, 92, 74]; // desaturated warm brown
  const blue: [number, number, number] = [40, 70, 175]; // strong cool reflection
  const buf = pixels(
    ...Array(14).fill(warm),
    ...Array(5).fill(blue),
  );
  const s = dominantIrisHsl(buf, 3, { skipDark: 55, skipBright: 235, minChroma: 0.1 });
  assert.ok(s);
  // The warm pigment cluster wins → warm hue, not the blue reflection.
  assert.ok(s.h < 60 || s.h > 300, `hue ${s.h} should read warm, not cool`);
});

test('dominantIrisHsl reports zero chroma for a colourless crop', () => {
  const s = dominantIrisHsl(pixels([100, 100, 100], [110, 110, 110], [90, 90, 90]), 3, {
    skipDark: 55,
    minChroma: 0.1,
  });
  assert.ok(s);
  assert.equal(s.s, 0);
  assert.equal(s.chromaticFraction, 0);
});
