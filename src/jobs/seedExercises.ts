/**
 * Seeds the guided-exercise library (EB-09). Idempotent — upserts by
 * `exerciseId`. Run with: `npm run seed:exercises`.
 *
 * Free tier: 3 evidence-backed screen-comfort routines.
 * Premium: 7 longer / deeper rituals.
 *
 * Every routine is RELAXATION / screen-fatigue relief only. Nothing here claims
 * to improve eyesight, correct vision, or treat any condition.
 */
import { connectDB, disconnectDB } from '../config/db';
import { Exercise } from '../models/Exercise';
import { ExerciseCategory } from '../models/Exercise';
import { logger } from '../utils/logger';

interface SeedExercise {
  exerciseId: string;
  title: string;
  description: string;
  whyItHelps: string;
  bestFor: string;
  cautions: string;
  steps: string[];
  stepDurationsSec: number[];
  category: ExerciseCategory;
  premium: boolean;
}

function withDuration(ex: SeedExercise): SeedExercise & { durationSec: number } {
  const durationSec = ex.stepDurationsSec.reduce((a, b) => a + b, 0);
  return { ...ex, durationSec };
}

/**
 * Catalog chosen for digital-screen comfort:
 * - 20-20-20 & conscious blinking have the strongest common guidance support
 * - Palming / focus shifting / distance gaze are widely used relaxation habits
 */
const EXERCISE_SEED: SeedExercise[] = [
  // ── Free (3) ────────────────────────────────────────────────────────────
  {
    exerciseId: '20-20-20-reset',
    title: '20-20-20 Reset',
    description:
      'Every 20 minutes, rest your eyes on something about 20 feet away for 20 seconds.',
    whyItHelps:
      'Long stretches of near-screen focus can leave your eyes feeling tired. '
      + 'A short distant gaze gives focusing effort a break and is one of the '
      + 'most recommended habits for digital screen comfort.',
    bestFor: 'Mid-work screen sessions, anytime your eyes feel “stuck” on the display',
    cautions:
      'This is a comfort habit, not a vision test or treatment. If you feel pain, '
      + 'sudden vision changes, or lasting discomfort, pause and seek professional care.',
    steps: [
      'Sit back from your screen and soften your shoulders.',
      'Look toward something about 6 metres / 20 feet away — a window, wall art, or far corner.',
      'Keep a soft, relaxed gaze for a full 20 seconds. Blink naturally.',
      'Return to your screen feeling a little fresher. Aim to repeat every 20 minutes.',
    ],
    stepDurationsSec: [5, 5, 20, 5],
    category: 'screen_break',
    premium: false,
  },
  {
    exerciseId: 'blink-break',
    title: 'Blink Break',
    description:
      'Slow, complete blinks to refresh comfort after screen staring.',
    whyItHelps:
      'People often blink less while looking at screens, which can leave eyes '
      + 'feeling dry or scratchy. Slow, full blinks help re-spread the tear film '
      + 'and ease that screen-tired feeling.',
    bestFor: 'Dry or scratchy comfort after long focus, AC rooms, or heavy scrolling',
    cautions:
      'Keep it gentle — never force or rub. Stop if blinking feels painful or irritated.',
    steps: [
      'Sit comfortably and relax your jaw and forehead.',
      'Close both eyes fully for two calm seconds.',
      'Open softly, then complete 8–10 slow, full blinks.',
      'Finish with eyes gently closed for three seconds, then open and notice the comfort.',
    ],
    stepDurationsSec: [8, 10, 25, 12],
    category: 'screen_break',
    premium: false,
  },
  {
    exerciseId: 'palming',
    title: 'Palming',
    description:
      'Rest your eyes in warm darkness to unwind after screen time.',
    whyItHelps:
      'Warm, complete darkness gives your eyes a sensory rest after bright screens. '
      + 'Many people find palming calming for a tired, overstimulated eye area — '
      + 'think of it as a mini reset, not a medical treatment.',
    bestFor: 'End of a meeting block, after bright screens, or when eyes feel overworked',
    cautions:
      'Cup hands lightly — never press on the eyeballs. Remove contact lenses if they feel dry first.',
    steps: [
      'Rub your palms together for a few seconds until they feel warmly tinged.',
      'Close your eyes. Gently cup palms over them so almost no light gets in — no pressure.',
      'Breathe slowly through the nose. Let the darkness and warmth settle for about 30 seconds.',
      'Lower your hands, open softly, and blink a few times before looking at a screen again.',
    ],
    stepDurationsSec: [8, 10, 30, 10],
    category: 'relaxation',
    premium: false,
  },

  // ── Premium (7) ─────────────────────────────────────────────────────────
  {
    exerciseId: 'near-far-relax',
    title: 'Near–Far Focus Shift',
    description:
      'Gently alternate focus between near and far to ease close-up fatigue.',
    whyItHelps:
      'Hours of near work keep focusing effort in one mode. Softly shifting between '
      + 'a near point and a distant point is a classic way to feel less “locked in” '
      + 'after laptops and phones — without straining.',
    bestFor: 'After 1+ hours of close reading, coding, or phone use',
    cautions:
      'Keep the shift soft and unhurried. Stop if you feel eye strain, headache, or dizziness.',
    steps: [
      'Hold a thumb (or pen) about 25 cm / 10 inches from your face.',
      'Focus softly on it for about 8 seconds without squinting.',
      'Shift your gaze to something far across the room for about 8 seconds.',
      'Continue alternating near and far for several calm cycles, then rest with eyes closed.',
    ],
    stepDurationsSec: [10, 20, 20, 40],
    category: 'focus_relief',
    premium: true,
  },
  {
    exerciseId: 'figure-8-focus',
    title: 'Figure-8 Gaze Trace',
    description:
      'Trace a slow sideways figure-8 to loosen a stiff screen stare.',
    whyItHelps:
      'Long staring can leave eye movements feeling sticky. A slow, imaginary '
      + 'figure-8 encourages gentle, wide eye movement and pairs well with a short break.',
    bestFor: 'Midday stiffness after continuous monitor use',
    cautions:
      'Move slowly. If you feel dizzy or nauseous, stop and look at a still distant point instead.',
    steps: [
      'Imagine a large sideways figure-8 (∞) about 2–3 metres ahead.',
      'Trace it smoothly with your eyes for several slow loops — no head bobbing.',
      'Reverse direction and continue at an easy pace.',
      'Close your eyes for a few breaths, then blink softly.',
    ],
    stepDurationsSec: [10, 25, 25, 15],
    category: 'focus_relief',
    premium: true,
  },
  {
    exerciseId: 'slow-eye-rolls',
    title: 'Slow Eye Circles',
    description:
      'Wide, relaxed circles to release tension from a fixed gaze.',
    whyItHelps:
      'Circular eye movements, done slowly, can help the eye area feel less rigid '
      + 'after staring at one distance. Think mobility and ease — not a workout.',
    bestFor: 'Quick desk breaks when your gaze feels locked forward',
    cautions:
      'Keep circles slow and comfortable. Skip this if it triggers dizziness or discomfort.',
    steps: [
      'Sit tall, soften your jaw, and look forward.',
      'Slowly roll your eyes in a wide, easy clockwise circle — five gentle loops.',
      'Reverse counterclockwise for five more loops.',
      'Close your eyes and rest for a few seconds before returning to your screen.',
    ],
    stepDurationsSec: [8, 20, 20, 12],
    category: 'relaxation',
    premium: true,
  },
  {
    exerciseId: 'horizon-gaze',
    title: 'Horizon Soft Gaze',
    description:
      'A longer distant gaze to deeply rest from close-up screen work.',
    whyItHelps:
      'Like an extended 20-20-20, a soft far gaze gives focusing effort a fuller rest. '
      + 'Ideal when short breaks haven’t been enough after a heavy screen day.',
    bestFor: 'End of a long work block, outdoors or by a window',
    cautions:
      'Stay somewhere safe (not while driving). Soften focus — don’t stare hard at one point.',
    steps: [
      'Find a window or open view with something distant to rest on.',
      'Let your eyes settle softly on the farthest comfortable point.',
      'Breathe slowly. Blink naturally. Stay with the soft gaze without forcing clarity.',
      'Gently bring attention back to the room, then to your screen if needed.',
    ],
    stepDurationsSec: [15, 20, 70, 15],
    category: 'focus_relief',
    premium: true,
  },
  {
    exerciseId: 'eye-area-cool-down',
    title: 'Eye-Area Cool Down',
    description:
      'A soothing wind-down for the skin and muscles around the eyes.',
    whyItHelps:
      'Screen days often leave the brow and under-eye area feeling tight. Light '
      + 'touch plus rest can help the area look and feel calmer — a cosmetic comfort ritual.',
    bestFor: 'Tired or puffy-looking days, post-scan wind-down, evening desk finish',
    cautions:
      'Use the lightest touch only. Never drag or press on the eyelids or eyeballs. Clean hands.',
    steps: [
      'Wash or sanitize hands. Close your eyes and take three slow breaths.',
      'With ring fingers, lightly tap around the orbital bone — not on the eye itself.',
      'Rest fingertips gently on closed lids for a few seconds (no pressure).',
      'Relax forehead and brow, then open slowly and blink.',
    ],
    stepDurationsSec: [20, 30, 20, 20],
    category: 'relaxation',
    premium: true,
  },
  {
    exerciseId: 'temple-relax',
    title: 'Temple & Brow Release',
    description:
      'A light self-massage to ease tension around temples and brows.',
    whyItHelps:
      'Squinting at screens and bright rooms can tighten the temples and brow. '
      + 'Slow circles with warm hands are a simple way to release that held tension.',
    bestFor: 'Tension headaches from screens, end-of-day tightness (comfort only)',
    cautions:
      'Pressure should feel pleasant, never sharp. Avoid if the area is injured or tender.',
    steps: [
      'Warm your hands by rubbing palms together.',
      'Place fingertips on your temples. Make small, slow circles for about a minute.',
      'Glide lightly along the brow line outward, then back to the temples.',
      'Cup eyes briefly (palming style) or simply rest with eyes closed.',
    ],
    stepDurationsSec: [10, 50, 30, 30],
    category: 'relaxation',
    premium: true,
  },
  {
    exerciseId: 'evening-wind-down',
    title: 'Evening Eye Wind-Down',
    description:
      'A longer bedtime ritual to settle your eyes after night phone use.',
    whyItHelps:
      'Evening screens can leave eyes feeling wired. Combining dim light, palming, '
      + 'slow blinks, and a soft distant gaze helps your eye area ease into rest — '
      + 'a lifestyle wind-down, not a sleep medication.',
    bestFor: 'Night phone habits, winding down 30–60 minutes before bed',
    cautions:
      'Dim lights; avoid bright screens during this ritual. Stop any step that feels uncomfortable.',
    steps: [
      'Dim the lights and put phones/laptops out of arm’s reach.',
      'Palm your closed eyes in warm darkness for about a minute.',
      'Follow with ten slow, complete blinks.',
      'Finish with a soft distant gaze (or closed-eye rest) and three calming breaths.',
    ],
    stepDurationsSec: [20, 60, 40, 40],
    category: 'screen_break',
    premium: true,
  },
];

async function seedExercises(): Promise<void> {
  await connectDB();
  try {
    const seeded = EXERCISE_SEED.map(withDuration);
    for (let i = 0; i < seeded.length; i++) {
      const ex = seeded[i];
      await Exercise.updateOne(
        { exerciseId: ex.exerciseId },
        { $set: { ...ex, order: i } },
        { upsert: true },
      );
    }
    // Drop any legacy ids no longer in the catalog.
    const keep = seeded.map((e) => e.exerciseId);
    await Exercise.deleteMany({ exerciseId: { $nin: keep } });

    const free = await Exercise.countDocuments({ premium: false });
    const premium = await Exercise.countDocuments({ premium: true });
    logger.info(
      `Exercise seed complete — ${seeded.length} upserted (free=${free}, premium=${premium})`,
    );
  } finally {
    await disconnectDB();
  }
}

seedExercises().catch((err) => {
  logger.error('Exercise seed failed', err);
  process.exit(1);
});
