import { Level } from '../../types/levels';

/** Normalized crop rectangle (fractions of image width/height, 0..1). */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Geometry posted by the client (on-device ML Kit face detection, EF-07).
 * Openness/symmetry are real measurements; crops locate the regions the LAB
 * analysis samples.
 */
export interface ScanGeometry {
  eyeOpennessL?: number;
  eyeOpennessR?: number;
  symmetry?: number; // 0..1, 1 = perfectly balanced
  crops?: {
    underEye?: Rect;
    /** Legacy single cheek rect from older clients (spans the nose — avoid). */
    cheek?: Rect;
    /** Lateral cheek patches, one under each eye's outer half. */
    cheekLeft?: Rect;
    cheekRight?: Rect;
    irisLeft?: Rect;
    irisRight?: Rect;
    /**
     * Outer-canthus (crow's-feet) patches — optional, sent by newer clients so
     * the fine-line texture reads the true crow's-feet skin. The pipeline falls
     * back to the under-eye rect when these are absent, so older clients work.
     */
    outerCanthusLeft?: Rect;
    outerCanthusRight?: Rect;
  };
}

/**
 * Scene white / exposure reference used to normalize the absolute-brightness
 * metrics (radiance). Estimated from near-neutral sclera pixels when readable,
 * else a conservative skin-brightness fallback. `gain` is a von-Kries channel
 * correction retained for audit; `whiteLum` is the reference white luminance
 * (0..255) that makes radiance exposure-invariant.
 */
export interface WhiteBalance {
  gain: { r: number; g: number; b: number };
  whiteLum: number | null;
  source: 'sclera' | 'skin-fallback' | 'none';
}

/** Deterministic, code-computed colour values (never final scores). */
export interface LabAnalysis {
  darkCircleLDelta: number; // L(cheek) - L(under-eye); larger = darker circles
  colorCast: 'blue' | 'purple' | 'brown' | 'neutral';
  rednessAValue: number; // eye-area a-channel vs neutral baseline
  /** Fine-line texture energy over the under-eye / crow's-feet skin; higher = more lines. */
  textureValue: number;
  /** Radiance dullness (0..100); higher = duller / less luminous eye-area skin. */
  dullnessValue: number;
  iris: { h: number; s: number; l: number; chromaticFraction: number } | null;
  wb: WhiteBalance;
}

/**
 * Continuous per-metric appearance read from the vision model (EB-05). Each is
 * a 0..1 severity (0 = none, 1 = strongest) averaged across the ensemble — finer
 * than the old 4 buckets so the score reflects THIS scan. Dark circles + redness
 * are still anchored to the pixel measurement downstream; puffiness + tired-look
 * are model-only.
 */
export interface GptClassification {
  puffiness: number;
  tiredLook: number;
  darkCircles: number;
  redness: number;
  /** Fine-line prominence, 0..1 (higher = more fine lines / less smooth). */
  fineLines: number;
  /** Dullness, 0..1 (higher = duller / less radiant). Radiance is 1 − dullness. */
  dullness: number;
  /** 0..1 ensemble agreement (1 = samples matched; 0.4 fixed for fallback). */
  confidence: number;
  source: 'gpt' | 'fallback';
}

/**
 * Reconciled per-metric result fed into the scoring engine (EB-06). Every metric
 * stores its level on the "undesirable appearance" convention (`none` = best),
 * so `none` always reads as "Good" on the client — radiance stores its dullness
 * level (none = not dull = radiant).
 */
export interface ReconciledAnalysis {
  darkCircles: { level: Level; lDelta: number };
  puffiness: { level: Level };
  redness: { level: Level; aValue: number };
  tiredLook: { level: Level };
  fineLines: { level: Level; textureValue: number };
  radiance: { level: Level; dullnessValue: number };
  symmetry: number; // 0..1
}
