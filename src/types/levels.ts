/**
 * Discrete severity levels — the ONLY vocabulary GPT-4o Vision is allowed to
 * return (EB-05) and the shared unit every "level" field across the schemas
 * stores. Numeric scores are always computed in code (EB-06), never by the model.
 */
export const LEVELS = ['none', 'mild', 'moderate', 'high'] as const;
export type Level = (typeof LEVELS)[number];

/** Map a discrete level to a 0..1 severity weight (used by the scoring engine). */
export const LEVEL_SEVERITY: Record<Level, number> = {
  none: 0.0,
  mild: 0.33,
  moderate: 0.66,
  high: 1.0,
};

/** Eye Freshness Score bands (EB-06). Kept here so schemas and scoring agree. */
export const FRESHNESS_BANDS = [
  'Fresh',
  'Good',
  'A Bit Tired',
  'Tired',
  'Very Tired',
] as const;
export type FreshnessBand = (typeof FRESHNESS_BANDS)[number];

/** Eye Comfort Score bands (EB-07). */
export const COMFORT_BANDS = ['Comfortable', 'Okay', 'Some Strain', 'High Strain'] as const;
export type ComfortBand = (typeof COMFORT_BANDS)[number];
