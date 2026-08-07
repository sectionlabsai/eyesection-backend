import { FreshnessBand } from '../../types/levels';

/**
 * Composite Eye Freshness Score — computed entirely in CODE (never by the vision
 * model). Each metric arrives as a continuous 0..100 sub-score (higher = fresher,
 * see severity.service) and is weighted:
 *   dark circles 25% · puffiness 22% · tired-eye 18% · redness 13% ·
 *   fine lines 10% · radiance 7% · symmetry 5%   (sum = 1.0)
 * The two skin-quality metrics (fine lines, radiance) carry modest weight so the
 * score's "freshness/tiredness" meaning stays stable while still reflecting them.
 */
export const FRESHNESS_WEIGHTS = {
  darkCircles: 0.25,
  puffiness: 0.22,
  tiredLook: 0.18,
  redness: 0.13,
  fineLines: 0.1,
  radiance: 0.07,
  symmetry: 0.05,
} as const;

export interface SubScores {
  darkCircles: number;
  puffiness: number;
  tiredLook: number;
  redness: number;
  fineLines: number;
  radiance: number;
  symmetry: number;
}

export interface FreshnessResult {
  freshnessScore: number; // 0..100
  band: FreshnessBand;
  subScores: SubScores;
}

export function bandForScore(score: number): FreshnessBand {
  if (score >= 80) return 'Fresh';
  if (score >= 65) return 'Good';
  if (score >= 50) return 'A Bit Tired';
  if (score >= 35) return 'Tired';
  return 'Very Tired';
}

/** Weight the continuous per-metric sub-scores into the final 0..100 score. */
export function computeFreshness(subScores: SubScores): FreshnessResult {
  const weighted =
    subScores.darkCircles * FRESHNESS_WEIGHTS.darkCircles +
    subScores.puffiness * FRESHNESS_WEIGHTS.puffiness +
    subScores.tiredLook * FRESHNESS_WEIGHTS.tiredLook +
    subScores.redness * FRESHNESS_WEIGHTS.redness +
    subScores.fineLines * FRESHNESS_WEIGHTS.fineLines +
    subScores.radiance * FRESHNESS_WEIGHTS.radiance +
    subScores.symmetry * FRESHNESS_WEIGHTS.symmetry;

  const freshnessScore = Math.round(Math.max(0, Math.min(100, weighted)));

  return { freshnessScore, band: bandForScore(freshnessScore), subScores };
}
