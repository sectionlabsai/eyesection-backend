import { ComfortBand } from '../../types/levels';

/**
 * Self-reported Eye Comfort Score — computed entirely in CODE from the user's
 * daily answers. This is SUBJECTIVE wellness feedback, never a diagnosis: all
 * copy is framed as "your answers suggest…" and never names a condition.
 *
 * Each raw input becomes a 0..1 "comfort contribution" (1 = most comfortable),
 * then the contributions are combined with the transparent weights below.
 */
export const COMFORT_WEIGHTS = {
  screenHours: 0.18, // more screen time = more strain
  drynessFeel: 0.15, // 0-3, higher = worse
  tirednessFeel: 0.15, // 0-3, higher = worse
  sleepHours: 0.12, // rested eyes feel better
  breakCompliance: 0.1, // 0-3, higher = better
  blinkCompliance: 0.1, // 0-3, higher = better
  brightnessComfort: 0.08, // 0-3, higher = better
  screenDistanceComfort: 0.08, // 0-3, higher = better
  nightMode: 0.04, // warmer light at night eases strain
} as const;

// Reference points used to normalise the free-numeric inputs into 0..1.
const SCREEN_HOURS_HEAVY = 12; // hours at/above which screen contribution = 0
const SLEEP_HOURS_TARGET = 8; // hours at/above which sleep contribution = 1

export interface ComfortInputs {
  screenHours: number;
  drynessFeel: number; // 0-3
  tirednessFeel: number; // 0-3
  sleepHours: number;
  breakCompliance: number; // 0-3
  blinkCompliance: number; // 0-3
  nightMode: boolean;
  brightnessComfort: number; // 0-3
  screenDistanceComfort: number; // 0-3
}

export interface ComfortResult {
  comfortScore: number; // 0..100
  band: ComfortBand;
  message: string;
}

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

/** 0-3 self-rating where higher already means "more comfortable". */
const rating03ToComfort = (v: number): number => clamp01(v / 3);

/** 0-3 self-rating where higher means "worse" (dryness / tiredness). */
const rating03ToRelief = (v: number): number => clamp01(1 - v / 3);

export function bandForComfort(score: number): ComfortBand {
  if (score >= 80) return 'Comfortable';
  if (score >= 60) return 'Okay';
  if (score >= 40) return 'Some Strain';
  return 'High Strain';
}

/** Kind, subjective message per band — never names a condition. */
export function messageForBand(band: ComfortBand): string {
  switch (band) {
    case 'Comfortable':
      return 'Your answers suggest your eyes are feeling comfortable today — nice work keeping a balanced screen routine.';
    case 'Okay':
      return 'Your answers suggest things are mostly okay. A few short breaks could help you feel even fresher.';
    case 'Some Strain':
      return 'Your answers suggest some eye strain today. Try the 20-20-20 rhythm and a little extra rest tonight.';
    case 'High Strain':
      return 'Your answers suggest your eyes have been working hard. Be gentle with them — more breaks, softer brightness and good sleep can help you feel better.';
  }
}

export function computeComfort(inputs: ComfortInputs): ComfortResult {
  const contributions = {
    screenHours: clamp01(1 - inputs.screenHours / SCREEN_HOURS_HEAVY),
    drynessFeel: rating03ToRelief(inputs.drynessFeel),
    tirednessFeel: rating03ToRelief(inputs.tirednessFeel),
    sleepHours: clamp01(inputs.sleepHours / SLEEP_HOURS_TARGET),
    breakCompliance: rating03ToComfort(inputs.breakCompliance),
    blinkCompliance: rating03ToComfort(inputs.blinkCompliance),
    brightnessComfort: rating03ToComfort(inputs.brightnessComfort),
    screenDistanceComfort: rating03ToComfort(inputs.screenDistanceComfort),
    nightMode: inputs.nightMode ? 1 : 0,
  };

  const weighted =
    contributions.screenHours * COMFORT_WEIGHTS.screenHours +
    contributions.drynessFeel * COMFORT_WEIGHTS.drynessFeel +
    contributions.tirednessFeel * COMFORT_WEIGHTS.tirednessFeel +
    contributions.sleepHours * COMFORT_WEIGHTS.sleepHours +
    contributions.breakCompliance * COMFORT_WEIGHTS.breakCompliance +
    contributions.blinkCompliance * COMFORT_WEIGHTS.blinkCompliance +
    contributions.brightnessComfort * COMFORT_WEIGHTS.brightnessComfort +
    contributions.screenDistanceComfort * COMFORT_WEIGHTS.screenDistanceComfort +
    contributions.nightMode * COMFORT_WEIGHTS.nightMode;

  const comfortScore = Math.round(clamp01(weighted) * 100);
  const band = bandForComfort(comfortScore);

  return { comfortScore, band, message: messageForBand(band) };
}
