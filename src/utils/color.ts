/**
 * Deterministic colour maths used by the appearance pipeline (EB-05) and the
 * iris classifier (EB-06). Pure functions — no I/O, fully explainable.
 */

export interface Lab {
  L: number; // 0..100
  a: number; // green(-) .. red(+)
  b: number; // blue(-) .. yellow(+)
}

export interface Hsl {
  h: number; // 0..360
  s: number; // 0..1
  l: number; // 0..1
}

/** sRGB (0..255) → CIE-L*a*b* (D65). */
export function rgbToLab(r: number, g: number, b: number): Lab {
  // sRGB → linear
  const lin = (c: number): number => {
    const v = c / 255;
    return v > 0.04045 ? ((v + 0.055) / 1.055) ** 2.4 : v / 12.92;
  };
  const rl = lin(r);
  const gl = lin(g);
  const bl = lin(b);

  // linear RGB → XYZ (D65)
  let x = (rl * 0.4124 + gl * 0.3576 + bl * 0.1805) / 0.95047;
  let y = rl * 0.2126 + gl * 0.7152 + bl * 0.0722;
  let z = (rl * 0.0193 + gl * 0.1192 + bl * 0.9505) / 1.08883;

  const f = (t: number): number => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  x = f(x);
  y = f(y);
  z = f(z);

  return {
    L: 116 * y - 16,
    a: 500 * (x - y),
    b: 200 * (y - z),
  };
}

/** sRGB (0..255) → HSL. */
export function rgbToHsl(r: number, g: number, b: number): Hsl {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;

  let h = 0;
  if (delta !== 0) {
    if (max === rn) h = ((gn - bn) / delta) % 6;
    else if (max === gn) h = (bn - rn) / delta + 2;
    else h = (rn - gn) / delta + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const l = (max + min) / 2;
  const s = delta === 0 ? 0 : delta / (1 - Math.abs(2 * l - 1));
  return { h, s, l };
}

export interface RgbAverage {
  r: number;
  g: number;
  b: number;
  count: number;
}

export interface IrisSample extends Hsl {
  /** Share of kept pixels that carried real colour — a signal-strength gauge. */
  chromaticFraction: number;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * Dominant iris colour, robust to the pupil and sclera. Averaging raw RGB over
 * an iris crop yields "a colour that exists nowhere" — the dark neutral pupil
 * and any glint drag saturation to zero and force a false grey. Instead:
 *  - drop pupil-dark and sclera-bright pixels,
 *  - take a SATURATION-WEIGHTED circular mean of hue, so neutral pixels (pupil,
 *    lashes) contribute ~nothing and the coloured iris ring dominates,
 *  - report saturation from the coloured pixels only (median), not the diluted
 *    whole-crop mean, and lightness as the median of survivors.
 * `chromaticFraction` lets the classifier lower confidence when the crop had
 * almost no real colour to read.
 */
export function dominantIrisHsl(
  data: Buffer,
  channels: number,
  opts: { skipDark?: number; skipBright?: number; minChroma?: number } = {},
): IrisSample | null {
  const skipDark = opts.skipDark ?? 55;
  const skipBright = opts.skipBright ?? 235;
  const minChroma = opts.minChroma ?? 0.1;

  let hx = 0;
  let hy = 0;
  const chromaSats: number[] = [];
  const lights: number[] = [];
  let survivors = 0;

  for (let i = 0; i + channels - 1 < data.length; i += channels) {
    const pr = data[i];
    const pg = data[i + 1];
    const pb = data[i + 2];
    const lum = (pr + pg + pb) / 3;
    if (lum < skipDark || lum > skipBright) continue;
    survivors += 1;

    const { h, s, l } = rgbToHsl(pr, pg, pb);
    lights.push(l);
    if (s >= minChroma) {
      const rad = (h * Math.PI) / 180;
      hx += s * Math.cos(rad);
      hy += s * Math.sin(rad);
      chromaSats.push(s);
    }
  }

  if (survivors === 0) return null;
  const l = median(lights);

  if (chromaSats.length === 0) {
    // Genuinely colourless crop — return neutral, but flag zero chroma so the
    // classifier treats the colour as unreliable rather than confidently grey.
    return { h: 0, s: 0, l, chromaticFraction: 0 };
  }

  const h = ((Math.atan2(hy, hx) * 180) / Math.PI + 360) % 360;
  return { h, s: median(chromaSats), l, chromaticFraction: chromaSats.length / survivors };
}

export interface AverageRgbOpts {
  /** Skip pixels with mean luminance below this (pupil / hard shadow). */
  skipDark?: number;
  /** Skip pixels with mean luminance above this (specular reflection). */
  skipBright?: number;
  /**
   * Skip bright, desaturated pixels (HSL s < 0.22 at l > 0.6) — the sclera
   * signature. Kept separate from a plain saturation floor so genuinely grey
   * irises (mid lightness) still sample.
   */
  skipScleraLike?: boolean;
  /**
   * Fraction (0..0.4) of the darkest AND brightest surviving pixels to drop
   * before averaging — a trimmed mean, robust to residual glints and shadow
   * bands that a plain mean would let skew the result.
   */
  trim?: number;
}

/**
 * Robust average RGB over a raw RGB(A) pixel buffer. Filters out pixels that
 * aren't the true region colour (pupil, glints, sclera), then takes a
 * luminance-trimmed mean of the survivors.
 */
export function averageRgb(
  data: Buffer,
  channels: number,
  opts: AverageRgbOpts = {},
): RgbAverage {
  const skipDark = opts.skipDark ?? 0;
  const skipBright = opts.skipBright ?? 256;
  const trim = Math.max(0, Math.min(0.4, opts.trim ?? 0));

  const kept: Array<{ r: number; g: number; b: number; lum: number }> = [];
  for (let i = 0; i + channels - 1 < data.length; i += channels) {
    const pr = data[i];
    const pg = data[i + 1];
    const pb = data[i + 2];
    const lum = (pr + pg + pb) / 3;
    if (lum < skipDark || lum > skipBright) continue;
    if (opts.skipScleraLike) {
      const { s, l } = rgbToHsl(pr, pg, pb);
      if (s < 0.22 && l > 0.6) continue;
    }
    kept.push({ r: pr, g: pg, b: pb, lum });
  }
  if (kept.length === 0) return { r: 0, g: 0, b: 0, count: 0 };

  kept.sort((a, b) => a.lum - b.lum);
  const drop = Math.floor(kept.length * trim);
  const mid = drop * 2 < kept.length ? kept.slice(drop, kept.length - drop) : kept;

  let r = 0;
  let g = 0;
  let b = 0;
  for (const p of mid) {
    r += p.r;
    g += p.g;
    b += p.b;
  }
  return { r: r / mid.length, g: g / mid.length, b: b / mid.length, count: mid.length };
}

/**
 * Average the "white-ish" pixels in a raw RGB(A) buffer — bright, low-saturation
 * pixels that approximate a neutral surface under the scene light (e.g. sclera).
 * Used to estimate the illuminant / exposure so absolute-brightness metrics
 * (radiance) can be normalized. Skips blown-out highlights so a flash glint
 * doesn't dominate. Returns `count = 0` when no neutral pixels were found.
 */
export function whitePatchAverage(
  data: Buffer,
  channels: number,
  opts: { minLum?: number; maxLum?: number; maxSat?: number } = {},
): RgbAverage {
  const minLum = opts.minLum ?? 140;
  const maxLum = opts.maxLum ?? 248; // drop clipped specular highlights
  const maxSat = opts.maxSat ?? 0.22; // sclera / neutral surfaces are near-grey

  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  for (let i = 0; i + channels - 1 < data.length; i += channels) {
    const pr = data[i];
    const pg = data[i + 1];
    const pb = data[i + 2];
    const lum = (pr + pg + pb) / 3;
    if (lum < minLum || lum > maxLum) continue;
    if (rgbToHsl(pr, pg, pb).s > maxSat) continue;
    r += pr;
    g += pg;
    b += pb;
    count += 1;
  }
  if (count === 0) return { r: 0, g: 0, b: 0, count: 0 };
  return { r: r / count, g: g / count, b: b / count, count };
}
