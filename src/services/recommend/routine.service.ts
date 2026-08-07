import { Level } from '../../types/levels';

/**
 * Builds a cosmetic, non-medical eye-area routine keyed to the user's top
 * concerns. Lifestyle guidance only — NEVER promises medical outcomes, never
 * names or treats a condition.
 */
export interface RoutineStep {
  concern: string;
  title: string;
  tips: string[];
}

/** Time-of-day / weekly care block shown on the Routine screen. */
export interface CareBlock {
  title: string;
  tips: string[];
}

export interface CareSchedule {
  morning: CareBlock;
  evening: CareBlock;
  weekly: CareBlock;
}

export interface EyeRoutine {
  intro: string;
  steps: RoutineStep[];
  schedule: CareSchedule;
}

export interface RoutineMetric {
  level: Level;
  /** Continuous 0..1 severity — orders concerns finely so ties don't tie. */
  severity?: number;
}

export interface RoutineAnalysis {
  darkCircles: RoutineMetric;
  puffiness: RoutineMetric;
  redness: RoutineMetric;
  tiredLook: RoutineMetric;
  fineLines?: RoutineMetric;
  /** Dullness level (none = radiant). Optional for older call sites. */
  radiance?: RoutineMetric;
  /** Lower severity = more balanced. Optional for older call sites. */
  symmetry?: RoutineMetric;
}

const CONCERN_CATALOG: Record<string, RoutineStep> = {
  dark_circles: {
    concern: 'dark_circles',
    title: 'Brighten the under-eye area',
    tips: [
      'Try a cool compress or chilled eye-area roller in the morning.',
      'Prioritise sleep and hydration — both help the area look fresher.',
      'A brightening under-eye cream or patch can even out appearance.',
    ],
  },
  puffiness: {
    concern: 'puffiness',
    title: 'Reduce a puffy look',
    tips: [
      'Use a cool metal roller or chilled spoons to de-puff.',
      'Ease off late-night salt and screens before bed.',
      'Sleep with your head slightly elevated.',
    ],
  },
  redness: {
    concern: 'redness',
    title: 'Calm eye-area redness appearance',
    tips: [
      'Take regular screen breaks and blink often to keep eyes comfortable.',
      'A gentle, fragrance-free eye cream can soothe the look of the area.',
      'Lower screen brightness in dim rooms.',
    ],
  },
  tired_look: {
    concern: 'tired_look',
    title: 'Freshen a tired-eye look',
    tips: [
      'Follow a 20-20-20 break rhythm to rest the eye area.',
      'A splash of cool water or a chilled compress revives the look quickly.',
      'Consistent sleep timing makes the biggest difference over a week.',
    ],
  },
  fine_lines: {
    concern: 'fine_lines',
    title: 'Soften the look of fine lines',
    tips: [
      'A gentle hydrating eye cream helps the skin look smoother and plumper.',
      'Stay well hydrated and protect the area from sun with a hat or shade.',
      'Pat products in gently — avoid tugging the delicate eye-area skin.',
    ],
  },
  radiance: {
    concern: 'radiance',
    title: 'Boost eye-area radiance',
    tips: [
      'Consistent sleep and water are the simplest way to a fresher, more luminous look.',
      'A brightening eye cream can help the area look more even and awake.',
      'Light circular strokes can help the area look more refreshed.',
    ],
  },
  symmetry: {
    concern: 'symmetry',
    title: 'Support a balanced look',
    tips: [
      'Light circular motions around the brow bone can help release minor tension.',
      'A consistent sleep position can reduce morning fluid imbalance.',
      'Short facial relaxation breaks help the eye area look more even.',
    ],
  },
};

const LEVEL_RANK: Record<Level, number> = { none: 0, mild: 1, moderate: 2, high: 3 };

/**
 * @param analysis reconciled per-metric levels
 * @param concerns optional user-selected concerns (onboarding) — these are
 *   prioritised alongside what the scan surfaced
 */
/**
 * Ordered concern keys for the featured top-of-results routine: user-selected
 * concerns first, then scan-surfaced (mild+) ranked by continuous severity,
 * de-duped. Always returns at least one so a routine is never empty.
 */
export function selectConcerns(analysis: RoutineAnalysis, concerns: string[] = []): string[] {
  const rankOf = (m: RoutineMetric): number => m.severity ?? LEVEL_RANK[m.level] / 3;
  const scanConcerns = (
    [
      ['dark_circles', analysis.darkCircles],
      ['puffiness', analysis.puffiness],
      ['redness', analysis.redness],
      ['tired_look', analysis.tiredLook],
      ...(analysis.fineLines ? [['fine_lines', analysis.fineLines] as [string, RoutineMetric]] : []),
      ...(analysis.radiance ? [['radiance', analysis.radiance] as [string, RoutineMetric]] : []),
      ...(analysis.symmetry ? [['symmetry', analysis.symmetry] as [string, RoutineMetric]] : []),
    ] as Array<[string, RoutineMetric]>
  )
    .filter(([, m]) => LEVEL_RANK[m.level] >= 1)
    .sort((a, b) => rankOf(b[1]) - rankOf(a[1]))
    .map(([key]) => key);

  const ordered = [...concerns.map(normaliseConcern), ...scanConcerns].filter(
    (c, i, arr) => c && CONCERN_CATALOG[c] && arr.indexOf(c) === i,
  );
  return (ordered.length ? ordered : ['tired_look']).slice(0, 3);
}

/**
 * Every metric the Tips & rituals screens can open. Featured concerns first,
 * then the remaining catalog keys so GPT (or curated fallback) fills tips for
 * each vital marker — not only the top 3.
 */
export function allMetricConcerns(
  analysis: RoutineAnalysis,
  concerns: string[] = [],
): string[] {
  const featured = selectConcerns(analysis, concerns);
  const rest = CONCERN_KEYS.filter((k) => !featured.includes(k));
  return [...featured, ...rest];
}

/** Curated morning / evening / weekly blocks keyed to top scan concerns. */
export function buildCareSchedule(
  analysis: RoutineAnalysis,
  concerns: string[] = [],
): CareSchedule {
  const featured = selectConcerns(analysis, concerns);
  const topLabel = featured[0]?.replace(/_/g, ' ') ?? 'eye-area freshness';

  return {
    morning: {
      title: 'Morning refresh',
      tips: [
        'Start with a cool compress or chilled roller around the eye area for a minute.',
        'Pat on a gentle eye cream with light tapping — no tugging.',
        'Drink a glass of water before screens to help the area look fresher.',
      ],
    },
    evening: {
      title: 'Evening wind-down',
      tips: [
        'Dim screens an hour before bed and keep brightness matched to the room.',
        'Use a cool compress if the area looks puffy after a long day.',
        'Keep a steady sleep window — consistent rest shows around the eyes.',
      ],
    },
    weekly: {
      title: 'This week’s focus',
      tips: [
        `Give a little extra care to ${topLabel} — short daily habits beat one long session.`,
        'Take regular 20-20-20 breaks on heavy screen days.',
        'Note which mornings feel freshest so you can keep the habits that help.',
      ],
    },
  };
}

/** Curated, non-medical routine — the safe fallback when GPT tips are unavailable. */
export function buildEyeRoutine(analysis: RoutineAnalysis, concerns: string[] = []): EyeRoutine {
  const steps = allMetricConcerns(analysis, concerns)
    .map((c) => CONCERN_CATALOG[c])
    .filter((s): s is RoutineStep => !!s);
  return {
    intro: 'A few gentle, cosmetic habits to help your eye area look and feel its freshest.',
    steps,
    schedule: buildCareSchedule(analysis, concerns),
  };
}

/** The catalog concern keys — the only steps a routine (curated or GPT) may use. */
export const CONCERN_KEYS = Object.keys(CONCERN_CATALOG);

/** Curated step for one concern — used to backfill concerns GPT didn't cover. */
export function curatedStep(key: string): RoutineStep | undefined {
  return CONCERN_CATALOG[key];
}

/** Human-readable level for a concern key, for prompting the GPT tips writer. */
export function concernLevel(analysis: RoutineAnalysis, key: string): string {
  const map: Record<string, RoutineMetric | undefined> = {
    dark_circles: analysis.darkCircles,
    puffiness: analysis.puffiness,
    redness: analysis.redness,
    tired_look: analysis.tiredLook,
    fine_lines: analysis.fineLines,
    radiance: analysis.radiance,
    symmetry: analysis.symmetry,
  };
  // "none" / missing → mild maintenance copy so every marker still gets tips.
  const level = map[key]?.level;
  return !level || level === 'none' ? 'mild' : level;
}

function normaliseConcern(raw: string): string {
  return raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
}
