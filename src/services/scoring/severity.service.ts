import { Level } from '../../types/levels';

/**
 * Continuous severity model (EB-06). Turns each metric into a smooth 0..1
 * severity (0 = pristine, 1 = strongest appearance) instead of snapping to four
 * discrete buckets, so two different faces produce genuinely different scores.
 *
 *  - Code-measured metrics (dark circles, redness) get a continuous severity
 *    from their LAB magnitude, then a confident vision-model read refines it.
 *  - Model-only metrics (puffiness, tired look) use the model's level directly.
 *
 * The discrete level is DERIVED from the final severity, so the badge the user
 * sees and the score always agree.
 */

export type Cutoffs = [number, number, number];

/**
 * Piecewise-linear severity through the three level cutoffs. Agrees with the
 * discrete bands (value at c0/c1/c2 sits on a boundary) but varies smoothly
 * between and above them, so magnitude — not just the bucket — reaches the score.
 */
export function severityFromValue(value: number, [c0, c1, c2]: Cutoffs): number {
  if (value <= 0) return 0;
  if (value < c0) return 0.25 * (value / c0);
  if (value < c1) return 0.25 + 0.25 * ((value - c0) / (c1 - c0));
  if (value < c2) return 0.5 + 0.25 * ((value - c1) / (c2 - c1));
  const span = Math.max(c2 - c1, 1); // extrapolate one more band toward 1.0
  return Math.min(1, 0.75 + 0.25 * ((value - c2) / span));
}

/** Discrete level from a continuous severity — midpoints of the 0/.33/.66/1 anchors. */
export function levelFromSeverity(severity: number): Level {
  if (severity < 0.165) return 'none';
  if (severity < 0.5) return 'mild';
  if (severity < 0.83) return 'moderate';
  return 'high';
}

/** Trust floor: below this ensemble agreement the model can't refine a code metric. */
export const GPT_TRUST_FLOOR = 0.6;

/**
 * Map ensemble agreement (0.6..1.0) to how hard the model pulls the code-measured
 * severity (0.4..0.8). A unanimous, high-detail ensemble read dominates while the
 * LAB magnitude still anchors it; a split vote is ignored for these metrics.
 */
export function gptWeightFromConfidence(confidence: number): number {
  if (confidence < GPT_TRUST_FLOOR) return 0;
  const t = (confidence - GPT_TRUST_FLOOR) / (1 - GPT_TRUST_FLOOR);
  return 0.4 + t * 0.4;
}

/** Blend a code-measured severity with the model's continuous 0..1 read. */
export function blendSeverity(codeSeverity: number, gptSeverity: number, gptWeight: number): number {
  const w = Math.max(0, Math.min(1, gptWeight));
  const s = codeSeverity * (1 - w) + Math.max(0, Math.min(1, gptSeverity)) * w;
  return Math.max(0, Math.min(1, s));
}

/** Severity → 0..100 sub-score (higher = fresher). */
export function severityToSubScore(severity: number): number {
  return Math.round((1 - Math.max(0, Math.min(1, severity))) * 100);
}
