import sharp from 'sharp';
import { env } from '../../config/env';
import {
  rgbToLab,
  averageRgb,
  dominantIrisHsl,
  whitePatchAverage,
  AverageRgbOpts,
} from '../../utils/color';
import { LabAnalysis, Rect, ScanGeometry, WhiteBalance } from './types';

/**
 * Layer 2 — deterministic LAB colour analysis in code (explainable, no model).
 *  - Dark circles: L(cheek) − L(under-eye) in LAB. Larger delta = darker circles.
 *  - Colour cast: from the a/b of the under-eye region (blue/purple vs brown).
 *  - Redness appearance: under-eye a-channel vs the (neutral-ish) cheek baseline.
 *  - Fine lines: high-frequency texture energy of the under-eye / crow's-feet skin.
 *  - Radiance: luminosity + tone-evenness of the eye-area skin, exposure-normalized
 *    against a sclera white reference (stored as `dullnessValue`; radiance = its inverse).
 *  - Iris: dominant HSL of the iris crop for classification (EB-06).
 *
 * Returns numeric values only — NOT final scores.
 */

const SAMPLE_PX = 48; // downscale each region for a stable average
const TEXTURE_PX = 96; // higher-res, edge-preserving grid for fine-line texture

// Skin patches: drop hard shadow / glare pixels and trim the luminance tails so
// one glint or shadow band can't skew the region average.
const SKIN_SAMPLE: AverageRgbOpts = { skipDark: 20, skipBright: 245, trim: 0.1 };
// Iris: exclude the pupil (dark) and any flash glint / sclera (bright), then read
// a saturation-weighted dominant hue so the neutral pupil can't wash the colour.
const IRIS_SKIP = { skipDark: 55, skipBright: 235, minChroma: 0.1 };

/** Extract a normalized rect and return its raw downsampled RGB pixels. */
async function regionPixels(
  image: sharp.Sharp,
  meta: sharp.Metadata,
  rect: Rect,
): Promise<{ data: Buffer; channels: number } | null> {
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (!width || !height) return null;

  const left = Math.max(0, Math.round(rect.x * width));
  const top = Math.max(0, Math.round(rect.y * height));
  const w = Math.max(1, Math.min(Math.round(rect.width * width), width - left));
  const h = Math.max(1, Math.min(Math.round(rect.height * height), height - top));
  if (w < 1 || h < 1 || left >= width || top >= height) return null;

  const { data, info } = await image
    .clone()
    .extract({ left, top, width: w, height: h })
    .resize(SAMPLE_PX, SAMPLE_PX, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  return { data, channels: info.channels };
}

/** Extract a normalized rect from the image and return its average RGB. */
async function regionAverage(
  image: sharp.Sharp,
  meta: sharp.Metadata,
  rect: Rect,
  sampleOpts: AverageRgbOpts = {},
): Promise<{ r: number; g: number; b: number } | null> {
  const px = await regionPixels(image, meta, rect);
  if (!px) return null;
  const avg = averageRgb(px.data, px.channels, sampleOpts);
  if (avg.count === 0) return null;
  return { r: avg.r, g: avg.g, b: avg.b };
}

/** Extract a rect as an edge-preserving square luminance grid (0..255 per cell). */
async function regionLumGrid(
  image: sharp.Sharp,
  meta: sharp.Metadata,
  rect: Rect,
  size: number,
): Promise<number[][] | null> {
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (!width || !height) return null;

  const left = Math.max(0, Math.round(rect.x * width));
  const top = Math.max(0, Math.round(rect.y * height));
  const w = Math.max(1, Math.min(Math.round(rect.width * width), width - left));
  const h = Math.max(1, Math.min(Math.round(rect.height * height), height - top));
  if (w < 4 || h < 4) return null;

  const { data, info } = await image
    .clone()
    .extract({ left, top, width: w, height: h })
    // 'nearest' keeps real high-frequency detail instead of blurring the lines away.
    .resize(size, size, { fit: 'fill', kernel: 'nearest' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const ch = info.channels;
  const grid: number[][] = [];
  for (let y = 0; y < size; y += 1) {
    const row: number[] = [];
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * ch;
      // Rec. 601 luma.
      row.push(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
    }
    grid.push(row);
  }
  return grid;
}

/**
 * Fine-line texture energy: mean absolute Laplacian over the interior, divided by
 * mean luminance so it measures relief (lines/creases) independent of exposure.
 * Scaled ×100 to land in a readable range against the cutoffs.
 */
function textureEnergy(grid: number[][]): number {
  const size = grid.length;
  let lapSum = 0;
  let lumSum = 0;
  let n = 0;
  for (let y = 1; y < size - 1; y += 1) {
    for (let x = 1; x < size - 1; x += 1) {
      const c = grid[y][x];
      const lap = Math.abs(4 * c - grid[y - 1][x] - grid[y + 1][x] - grid[y][x - 1] - grid[y][x + 1]);
      lapSum += lap;
      lumSum += c;
      n += 1;
    }
  }
  if (n === 0) return 0;
  const meanLum = lumSum / n;
  return (lapSum / n / (meanLum + 1)) * 100;
}

/**
 * Estimate the scene white / exposure from near-neutral sclera pixels inside the
 * iris crops. Falls back to a bright-skin reference when no sclera is readable so
 * radiance still has an exposure anchor; `whiteLum` is null only when nothing is
 * available (radiance then uses a nominal reference).
 */
async function estimateSceneWhite(
  image: sharp.Sharp,
  meta: sharp.Metadata,
  crops: NonNullable<ScanGeometry['crops']>,
): Promise<WhiteBalance> {
  const whites: Array<{ r: number; g: number; b: number; count: number }> = [];
  for (const rect of [crops.irisLeft, crops.irisRight]) {
    if (!rect) continue;
    const px = await regionPixels(image, meta, rect);
    if (!px) continue;
    const wp = whitePatchAverage(px.data, px.channels);
    if (wp.count > 8) whites.push(wp);
  }

  if (whites.length > 0) {
    const total = whites.reduce((s, w) => s + w.count, 0);
    const r = whites.reduce((s, w) => s + w.r * w.count, 0) / total;
    const g = whites.reduce((s, w) => s + w.g * w.count, 0) / total;
    const b = whites.reduce((s, w) => s + w.b * w.count, 0) / total;
    const grey = (r + g + b) / 3;
    // von-Kries channel gains, clamped so a noisy reference can't wildly distort.
    const clamp = (v: number): number => Math.max(0.75, Math.min(1.3, v));
    return {
      gain: { r: clamp(grey / (r || grey)), g: clamp(grey / (g || grey)), b: clamp(grey / (b || grey)) },
      whiteLum: grey,
      source: 'sclera',
    };
  }

  // Skin fallback: the brightest cheek/under-eye average as a coarse exposure ref.
  const skinRects = [crops.cheekLeft, crops.cheekRight, crops.cheek, crops.underEye].filter(
    (r): r is Rect => !!r,
  );
  let maxLum: number | null = null;
  for (const rect of skinRects) {
    const avg = await regionAverage(image, meta, rect, SKIN_SAMPLE);
    if (!avg) continue;
    const lum = (avg.r + avg.g + avg.b) / 3;
    if (maxLum === null || lum > maxLum) maxLum = lum;
  }
  if (maxLum !== null) {
    // Skin is darker than a true white; scale up to approximate the illuminant.
    return { gain: { r: 1, g: 1, b: 1 }, whiteLum: Math.min(255, maxLum / 0.7), source: 'skin-fallback' };
  }
  return { gain: { r: 1, g: 1, b: 1 }, whiteLum: null, source: 'none' };
}

/**
 * Radiance dullness (0..100, higher = duller). Blends relative luminance
 * (skin brightness vs the scene white), tone evenness (low luminance variance),
 * and a small controlled-glow term (moderate specular highlights). Radiance =
 * 100 − dullness; kept as dullness so it shares the "higher = worse" convention.
 */
async function computeDullness(
  image: sharp.Sharp,
  meta: sharp.Metadata,
  crops: NonNullable<ScanGeometry['crops']>,
  wb: WhiteBalance,
): Promise<number> {
  const rects = [crops.underEye, crops.cheekLeft, crops.cheekRight, crops.cheek].filter(
    (r): r is Rect => !!r,
  );
  const lums: number[] = [];
  for (const rect of rects) {
    const grid = await regionLumGrid(image, meta, rect, SAMPLE_PX);
    if (!grid) continue;
    for (const row of grid) for (const v of row) lums.push(v);
  }
  if (lums.length === 0) return 50; // neutral when no skin region is available

  const meanL = lums.reduce((a, b) => a + b, 0) / lums.length;
  const variance = lums.reduce((a, b) => a + (b - meanL) ** 2, 0) / lums.length;
  const stdL = Math.sqrt(variance);
  const specularFraction = lums.filter((v) => v > 235).length / lums.length;

  const whiteLum = wb.whiteLum ?? 210; // nominal well-lit white when unmeasured
  const relLum = Math.max(0, Math.min(1, meanL / Math.max(60, whiteLum)));

  const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));
  const brightness = clamp01((relLum - 0.4) / (0.9 - 0.4)); // dark→0, near-white→1
  const evenness = 1 - clamp01(stdL / meanL / 0.3); // low coefficient of variation = even tone
  const glow = clamp01(specularFraction / 0.04); // a touch of highlight reads as glow

  const radiance01 = clamp01(0.5 * brightness + 0.4 * evenness + 0.1 * glow);
  return Math.round((1 - radiance01) * 100);
}

/** Fine-line texture over the crow's-feet patches when present, else the under-eye skin. */
async function computeTexture(
  image: sharp.Sharp,
  meta: sharp.Metadata,
  crops: NonNullable<ScanGeometry['crops']>,
): Promise<number> {
  const rects = [crops.outerCanthusLeft, crops.outerCanthusRight].filter(
    (r): r is Rect => !!r,
  );
  const targets = rects.length > 0 ? rects : crops.underEye ? [crops.underEye] : [];
  if (targets.length === 0) return 0;

  const energies: number[] = [];
  for (const rect of targets) {
    const grid = await regionLumGrid(image, meta, rect, TEXTURE_PX);
    if (grid) energies.push(textureEnergy(grid));
  }
  if (energies.length === 0) return 0;
  return energies.reduce((a, b) => a + b, 0) / energies.length;
}

function classifyCast(a: number, b: number): LabAnalysis['colorCast'] {
  // a>0 red, b<0 blue, b>0 yellow. Purple ~ (a>0, b<0); brown ~ (a>0, b>0).
  if (a < 6 && Math.abs(b) < 6) return 'neutral';
  if (b < -4) return a > 8 ? 'purple' : 'blue';
  return 'brown';
}

/**
 * Cheek baseline: prefer the two lateral patches (one under each eye — they
 * avoid the nose and its shadows), averaged; fall back to the legacy single
 * `cheek` rect from older clients.
 */
async function cheekAverage(
  image: sharp.Sharp,
  meta: sharp.Metadata,
  crops: NonNullable<ScanGeometry['crops']>,
): Promise<{ r: number; g: number; b: number } | null> {
  const lateral = [crops.cheekLeft, crops.cheekRight].filter((r): r is Rect => !!r);
  const rects = lateral.length > 0 ? lateral : crops.cheek ? [crops.cheek] : [];

  const samples: Array<{ r: number; g: number; b: number }> = [];
  for (const rect of rects) {
    const avg = await regionAverage(image, meta, rect, SKIN_SAMPLE);
    if (avg) samples.push(avg);
  }
  if (samples.length === 0) return null;
  return {
    r: samples.reduce((sum, s) => sum + s.r, 0) / samples.length,
    g: samples.reduce((sum, s) => sum + s.g, 0) / samples.length,
    b: samples.reduce((sum, s) => sum + s.b, 0) / samples.length,
  };
}

export async function computeLab(
  imageBuffer: Buffer,
  geometry: ScanGeometry,
): Promise<LabAnalysis> {
  const crops = geometry.crops ?? {};
  const image = sharp(imageBuffer);
  const meta = await image.metadata();

  const wb = await estimateSceneWhite(image, meta, crops);

  const underEyeRgb = crops.underEye
    ? await regionAverage(image, meta, crops.underEye, SKIN_SAMPLE)
    : null;
  const cheekRgb = await cheekAverage(image, meta, crops);

  let darkCircleLDelta = 0;
  let colorCast: LabAnalysis['colorCast'] = 'neutral';
  let rednessAValue = 0;

  if (underEyeRgb) {
    const underLab = rgbToLab(underEyeRgb.r, underEyeRgb.g, underEyeRgb.b);
    colorCast = classifyCast(underLab.a, underLab.b);

    if (cheekRgb) {
      const cheekLab = rgbToLab(cheekRgb.r, cheekRgb.g, cheekRgb.b);
      darkCircleLDelta = Math.max(0, cheekLab.L - underLab.L);
      // Redness appearance: how much redder the under-eye is than the cheek baseline.
      rednessAValue = Math.max(0, underLab.a - cheekLab.a);
    } else {
      // No cheek reference — fall back to absolute a-channel above neutral.
      rednessAValue = Math.max(0, underLab.a - 8);
    }
  }

  // Fine lines (texture relief) + radiance dullness (exposure-normalized skin
  // luminance/evenness). Independent of the differential dark-circle/redness path.
  const textureValue = await computeTexture(image, meta, crops);
  const dullnessValue = await computeDullness(image, meta, crops, wb);

  // Iris: sample BOTH eyes and keep whichever gave the stronger colour signal
  // (one eye is often half-occluded by a lid or blown out by a flash glint).
  let iris: LabAnalysis['iris'] = null;
  for (const rect of [crops.irisLeft, crops.irisRight]) {
    if (!rect) continue;
    const px = await regionPixels(image, meta, rect);
    if (!px) continue;
    const sample = dominantIrisHsl(px.data, px.channels, IRIS_SKIP);
    if (sample && (!iris || sample.chromaticFraction > iris.chromaticFraction)) {
      iris = sample;
    }
  }

  return { darkCircleLDelta, colorCast, rednessAValue, textureValue, dullnessValue, iris, wb };
}

type Cutoffs = [number, number, number];

/** Parse "a,b,c" env override; falls back when malformed or not ascending. */
function parseCutoffs(raw: string | undefined, fallback: Cutoffs): Cutoffs {
  if (!raw) return fallback;
  const parts = raw.split(',').map((s) => Number(s.trim()));
  if (parts.length === 3 && parts.every(Number.isFinite) && parts[0] < parts[1] && parts[1] < parts[2]) {
    return [parts[0], parts[1], parts[2]];
  }
  return fallback;
}

/**
 * Level cutoffs for the code-derived deltas. The defaults are cosmetic
 * heuristics; `npm run calibrate:thresholds` distils GPT majority labels from
 * accumulated scans into recommended env overrides.
 */
// Defaults recalibrated to the real under-eye/cheek delta distribution — most
// faces sit at an L-delta of 6-9 and an a-delta of 1-3, so the old 12/20 and
// 8/15 ceilings were unreachable and collapsed everyone to "mild"/"none".
// `npm run calibrate:thresholds` refines these from accumulated scans.
export const DARK_CIRCLE_CUTOFFS = parseCutoffs(env.DARK_CIRCLE_THRESHOLDS, [4, 9, 15]);
export const REDNESS_CUTOFFS = parseCutoffs(env.REDNESS_THRESHOLDS, [2, 6, 12]);
// Fine-line texture energy and radiance-dullness cutoffs. These defaults are
// cosmetic starting points (the model read dominates when the ensemble agrees);
// `npm run calibrate:thresholds` refines them once enough scans accumulate.
export const FINELINES_CUTOFFS = parseCutoffs(env.FINELINES_THRESHOLDS, [8, 16, 28]);
export const DULLNESS_CUTOFFS = parseCutoffs(env.RADIANCE_THRESHOLDS, [25, 45, 65]);

function levelFromCutoffs(value: number, cutoffs: Cutoffs): 'none' | 'mild' | 'moderate' | 'high' {
  if (value < cutoffs[0]) return 'none';
  if (value < cutoffs[1]) return 'mild';
  if (value < cutoffs[2]) return 'moderate';
  return 'high';
}

export function levelFromLDelta(lDelta: number): 'none' | 'mild' | 'moderate' | 'high' {
  return levelFromCutoffs(lDelta, DARK_CIRCLE_CUTOFFS);
}

export function levelFromRedness(aValue: number): 'none' | 'mild' | 'moderate' | 'high' {
  return levelFromCutoffs(aValue, REDNESS_CUTOFFS);
}
