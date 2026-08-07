import { Exercise, IExercise } from '../models';

/**
 * Library view.
 *
 * Premium is enforced server-side: entitlement is the single source of truth
 * (see entitlement.service) and is never trusted from the client. A locked
 * routine ships its marketing metadata (title, duration, "why it helps" copy)
 * so the client can render a paywall teaser, but the actual step-by-step
 * guidance — the gated content — is WITHHELD until the caller is entitled.
 * Free/anonymous clients therefore never receive premium routine content in the
 * payload; the client refetches the catalog when entitlement changes so a newly
 * upgraded user picks up the steps.
 *
 * `premium` marks routines that require EyeSection Pro; `locked` reflects the
 * caller's current entitlement so free clients can render the paywall affordance.
 */
function toView(ex: IExercise, unlocked: boolean): Record<string, unknown> {
  const stepDurations =
    ex.stepDurationsSec?.length === ex.steps.length
      ? ex.stepDurationsSec
      : ex.steps.map(() =>
          Math.max(5, Math.floor(ex.durationSec / Math.max(1, ex.steps.length))),
        );

  return {
    id: ex.exerciseId,
    title: ex.title,
    description: ex.description,
    whyItHelps: ex.whyItHelps ?? '',
    bestFor: ex.bestFor ?? '',
    cautions: ex.cautions ?? '',
    durationSec: ex.durationSec,
    category: ex.category,
    premium: ex.premium,
    locked: !unlocked,
    // Gated content: only entitled callers receive the routine's steps. Locked
    // routines return empty arrays so premium guidance can't be extracted from
    // the free catalog response.
    steps: unlocked ? ex.steps : [],
    stepDurationsSec: unlocked ? stepDurations : [],
  };
}

export async function listExercises(
  isPremium: boolean,
): Promise<Record<string, unknown>[]> {
  const exercises = await Exercise.find().sort({ order: 1 });
  return exercises.map((ex) => toView(ex, isPremium || !ex.premium));
}
