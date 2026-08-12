import OpenAI from 'openai';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { env } from '../../config/env';
import { logger } from '../../utils/logger';
import { getRedis } from '../../config/redis';
import { sanitizeForPrompt, sanitizeListForPrompt } from '../../utils/prompt';
import {
  EyeRoutine,
  RoutineStep,
  RoutineAnalysis,
  CareSchedule,
  CareBlock,
  buildEyeRoutine,
  buildCareSchedule,
  allMetricConcerns,
  concernLevel,
  curatedStep,
  CONCERN_KEYS,
} from './routine.service';

/**
 * Per-scan cosmetic tips written by the vision/text model for THIS specific
 * result, so Tips & rituals on every vital marker reads as tailored rather than
 * templated. Also writes morning / evening / weekly care blocks for the Routine
 * screen. Heavily guardrailed: cosmetic & lifestyle ONLY, never medical.
 *
 * Tip gating (client): tip[0] is free; tips[1] and tips[2] are Premium.
 * We always return exactly 3 tips per metric so that gate is consistent.
 */

const CONCERN_TITLES: Record<string, string> = {
  dark_circles: 'Brighten the under-eye area',
  puffiness: 'Reduce a puffy look',
  redness: 'Calm eye-area redness appearance',
  tired_look: 'Freshen a tired-eye look',
  fine_lines: 'Soften the look of fine lines',
  radiance: 'Boost eye-area radiance',
  symmetry: 'Support a balanced look',
};

const CONCERN_ENUM = [
  'dark_circles',
  'puffiness',
  'redness',
  'tired_look',
  'fine_lines',
  'radiance',
  'symmetry',
] as const;

/** Optional profile context so schedule tips match this user's habits. */
export interface RoutineUserContext {
  goal?: string;
  careProducts?: string[];
  dailyScreenHours?: number;
  baselineComfort?: string;
  nightPhoneUse?: boolean;
}

/** Options controlling how a routine is generated. */
export interface RoutineGenOptions {
  /**
   * Bypass the shared Redis cache (both read AND write) and ask the model for a
   * genuinely fresh variation. Used by the user-triggered "regenerate" action —
   * without this a regenerate with unchanged levels+profile would just return
   * the identical cached text. Skipping the write keeps the global cache clean
   * and deterministic for the automatic post-scan path.
   */
  forceFresh?: boolean;
  /** Extra entropy mixed into the prompt so repeat regenerations differ. */
  variationSeed?: string;
}

const SYSTEM_PROMPT = `You are a gentle COSMETIC eye-area wellness coach for a beauty & wellness app.
You are given the eye-area appearance findings for one person. Write short,
warm, PRACTICAL cosmetic & lifestyle tips tailored to those findings.

STRICT RULES — never break one:
- Cosmetic and lifestyle ONLY. This is NOT medical advice.
- Never name, diagnose, treat, screen for, or imply ANY medical or eye condition.
- Never promise results. Phrase around APPEARANCE ("can help the under-eye area
  look fresher"), never a cure or a health outcome.
- No medications, no supplements, no brand names, no treatments or procedures.
- Allowed topics only: habits (sleep, hydration, screen breaks, salt/late meals),
  cool compresses / chilled rollers, gentle massage, and cosmetic products by
  TYPE only (e.g. "a brightening eye cream", "a colour corrector").
- Each tip is ONE short, friendly sentence.
- Give EXACTLY 3 tips per concern (the first is free; the next two are premium).
- Write a step for EACH listed concern and ONLY those concerns.
- For mild / maintenance findings, still give useful upkeep tips — never leave a step empty.
- Also write a care SCHEDULE with morning, evening, and weekly blocks (title + exactly 3 tips each),
  tailored to THIS person's findings and profile (screen habits, goal, products they already use).

Return a one-sentence encouraging intro, the concern steps, and the schedule.`;

const tips3 = z.array(z.string().min(1).max(200)).min(1).max(4);
const careBlockSchema = z.object({
  title: z.string().min(1).max(80),
  tips: tips3,
});

const stepSchema = z.object({
  concern: z.string(),
  title: z.string().max(80).default(''),
  tips: z.array(z.string().min(1).max(200)).max(4).default([]),
});
const routineSchema = z.object({
  intro: z.string().min(1).max(240),
  steps: z.array(stepSchema).max(8).default([]),
  schedule: z
    .object({
      morning: careBlockSchema,
      evening: careBlockSchema,
      weekly: careBlockSchema,
    })
    .optional(),
});

const RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'eye_routine',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['intro', 'steps', 'schedule'],
      properties: {
        intro: { type: 'string' },
        steps: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['concern', 'title', 'tips'],
            properties: {
              concern: {
                type: 'string',
                enum: [...CONCERN_ENUM],
              },
              title: { type: 'string' },
              tips: { type: 'array', items: { type: 'string' } },
            },
          },
        },
        schedule: {
          type: 'object',
          additionalProperties: false,
          required: ['morning', 'evening', 'weekly'],
          properties: {
            morning: {
              type: 'object',
              additionalProperties: false,
              required: ['title', 'tips'],
              properties: {
                title: { type: 'string' },
                tips: { type: 'array', items: { type: 'string' } },
              },
            },
            evening: {
              type: 'object',
              additionalProperties: false,
              required: ['title', 'tips'],
              properties: {
                title: { type: 'string' },
                tips: { type: 'array', items: { type: 'string' } },
              },
            },
            weekly: {
              type: 'object',
              additionalProperties: false,
              required: ['title', 'tips'],
              properties: {
                title: { type: 'string' },
                tips: { type: 'array', items: { type: 'string' } },
              },
            },
          },
        },
      },
    },
  },
} as const;

let client: OpenAI | null = null;
function getClient(): OpenAI | null {
  if (!env.OPENAI_API_KEY) return null;
  if (!client) client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  return client;
}

/** Pad / trim to exactly 3 tip sentences, filling gaps from the curated catalog. */
function ensureThreeTips(key: string, tips: string[]): string[] {
  const curated = curatedStep(key)?.tips ?? [];
  const out = tips.filter((t) => t.trim().length > 0).slice(0, 3);
  for (const fallback of curated) {
    if (out.length >= 3) break;
    if (!out.includes(fallback)) out.push(fallback);
  }
  while (out.length < 3) {
    out.push('A short rest, cool compress, and steady hydration can help this area look fresher.');
  }
  return out;
}

function ensureBlock(block: CareBlock | undefined, fallback: CareBlock): CareBlock {
  const tips = (block?.tips ?? [])
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .slice(0, 3);
  while (tips.length < 3) {
    const next = fallback.tips[tips.length];
    if (!next || tips.includes(next)) break;
    tips.push(next);
  }
  while (tips.length < 3) {
    tips.push(fallback.tips[tips.length] ?? 'Keep a gentle, steady habit this week.');
  }
  return {
    title: block?.title?.trim() || fallback.title,
    tips,
  };
}

function mergeSchedule(
  gpt: CareSchedule | undefined,
  fallback: CareSchedule,
): CareSchedule {
  return {
    morning: ensureBlock(gpt?.morning, fallback.morning),
    evening: ensureBlock(gpt?.evening, fallback.evening),
    weekly: ensureBlock(gpt?.weekly, fallback.weekly),
  };
}

function profileLines(ctx?: RoutineUserContext): string {
  if (!ctx) return '';
  const lines: string[] = [];
  // goal / baselineComfort / careProducts are user-supplied free text — sanitize
  // before injection so a stored value can't smuggle prompt instructions.
  if (ctx.goal) lines.push(`- Goal: ${sanitizeForPrompt(ctx.goal, 120)}`);
  if (ctx.baselineComfort) {
    lines.push(`- Baseline comfort: ${sanitizeForPrompt(ctx.baselineComfort, 60)}`);
  }
  if (ctx.dailyScreenHours != null) {
    lines.push(`- Typical daily screen time: ~${ctx.dailyScreenHours} hours`);
  }
  if (ctx.nightPhoneUse === true) lines.push('- Uses phone late at night');
  if (ctx.nightPhoneUse === false) lines.push('- Avoids late-night phone use');
  if (ctx.careProducts?.length) {
    lines.push(
      `- Care products they already use: ${sanitizeListForPrompt(ctx.careProducts, 60).join(', ')}`,
    );
  }
  if (lines.length === 0) return '';
  return `\nUser profile (personalize the schedule around this):\n${lines.join('\n')}\n`;
}

// The generated routine is a pure function of the DISCRETE concern levels and
// the (sanitized) profile inputs the model is shown — not the exact continuous
// severities — so two scans with the same levels + profile can reuse one
// generation. Cached routines carry no user identifiers (only cosmetic advice),
// so the key is global across users to maximize the hit rate. Bump the version
// prefix if the prompt/shape changes so stale entries are ignored.
const ROUTINE_CACHE_TTL_SEC = 7 * 24 * 60 * 60; // 7 days
const routineCacheKey = (fingerprint: string): string => `routine:v1:${fingerprint}`;

/** Stable fingerprint of everything that determines the generated routine. */
function routineFingerprint(
  selected: string[],
  analysis: RoutineAnalysis,
  ctx?: RoutineUserContext,
): string {
  const levels = selected.map((k) => `${k}:${concernLevel(analysis, k)}`);
  const profile = [
    `goal=${(ctx?.goal ?? '').trim().toLowerCase()}`,
    `comfort=${(ctx?.baselineComfort ?? '').trim().toLowerCase()}`,
    `screen=${ctx?.dailyScreenHours ?? ''}`,
    `night=${ctx?.nightPhoneUse ?? ''}`,
    `products=${[...(ctx?.careProducts ?? [])]
      .map((p) => p.trim().toLowerCase())
      .sort()
      .join('|')}`,
  ];
  return createHash('sha1').update([...levels, ...profile].join(';')).digest('hex');
}

/** Read a cached routine. Fails open (returns null) on any Redis/parse error. */
async function readRoutineCache(key: string): Promise<EyeRoutine | null> {
  try {
    const raw = await getRedis().get(key);
    return raw ? (JSON.parse(raw) as EyeRoutine) : null;
  } catch (err) {
    logger.warn('Routine cache read failed — generating fresh', err);
    return null;
  }
}

/** Best-effort cache write — a Redis error never blocks returning the routine. */
async function writeRoutineCache(key: string, routine: EyeRoutine): Promise<void> {
  try {
    await getRedis().set(key, JSON.stringify(routine), 'EX', ROUTINE_CACHE_TTL_SEC);
  } catch (err) {
    logger.warn('Routine cache write failed', err);
  }
}

/**
 * Generate a tailored cosmetic tip set for EVERY vital marker on this scan,
 * plus morning / evening / weekly care blocks. Falls back to the curated
 * catalog when no model is configured, the call fails, or the model skips a concern.
 *
 * Results are cached in Redis keyed by the concern levels + profile, so repeat
 * scans with a similar profile reuse one text-model call instead of paying for a
 * fresh generation each time.
 */
export async function generateEyeRoutine(
  analysis: RoutineAnalysis,
  concerns: string[] = [],
  userContext?: RoutineUserContext,
  options: RoutineGenOptions = {},
): Promise<EyeRoutine> {
  const openai = getClient();
  const selected = allMetricConcerns(analysis, concerns);
  const fallbackSchedule = buildCareSchedule(analysis, concerns);
  if (!openai) return buildEyeRoutine(analysis, concerns);

  // Only the model-backed path is worth caching (the curated fallback is local
  // and cheap). Reuse a prior generation for the same levels + profile. A
  // forceFresh (regenerate) request skips the cache entirely so the user gets a
  // new variation and the shared global cache is left untouched.
  const cacheKey = !options.forceFresh && selected.length > 0
    ? routineCacheKey(routineFingerprint(selected, analysis, userContext))
    : null;
  if (cacheKey) {
    const cached = await readRoutineCache(cacheKey);
    if (cached) return cached;
  }

  let intro = 'A few gentle, cosmetic habits to help your eye area look and feel its freshest.';
  const gptSteps = new Map<string, RoutineStep>();
  let gptSchedule: CareSchedule | undefined;

  if (selected.length > 0) {
    const findings = selected
      .map((key) => `- ${key.replace(/_/g, ' ')}: ${concernLevel(analysis, key)}`)
      .join('\n');
    // On a regenerate, nudge the model toward a genuinely different-but-valid
    // set of habits and phrasing (the variation token adds entropy so repeat
    // regenerations don't converge on the same wording).
    const variationLine = options.forceFresh
      ? `\n\nThis is a REGENERATION: produce a genuinely fresh alternative — vary the ` +
        `specific habits, emphasis, and phrasing while staying accurate to the findings ` +
        `and within every rule above. Variation token: ${options.variationSeed ?? Date.now()}.`
      : '';
    const userPrompt =
      `Findings to address (write a step with EXACTLY 3 tips for each, in this order):\n${findings}\n\n` +
      `Use exactly these concern keys: ${selected.join(', ')}.` +
      profileLines(userContext) +
      `\nAlso write schedule.morning, schedule.evening, and schedule.weekly — each with a short title and EXACTLY 3 tips ` +
      `suited to this person's findings and profile (morning refresh, evening wind-down, weekly focus).` +
      variationLine;

    try {
      const res = await openai.chat.completions.create({
        model: env.OPENAI_TEXT_MODEL,
        response_format: RESPONSE_FORMAT,
        // Higher temperature only on regenerate so the fresh set really differs;
        // the automatic post-scan path keeps the model's default for stability.
        ...(options.forceFresh ? { temperature: 1 } : {}),
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
      });
      const raw = res.choices[0]?.message?.content;
      const parsed = raw ? routineSchema.safeParse(JSON.parse(raw)) : null;
      if (parsed?.success) {
        if (parsed.data.intro) intro = parsed.data.intro;
        for (const s of parsed.data.steps) {
          if (
            s.tips.length > 0 &&
            selected.includes(s.concern) &&
            CONCERN_KEYS.includes(s.concern)
          ) {
            gptSteps.set(s.concern, {
              concern: s.concern,
              title: CONCERN_TITLES[s.concern] ?? s.title,
              tips: ensureThreeTips(s.concern, s.tips),
            });
          }
        }
        if (parsed.data.schedule) {
          gptSchedule = parsed.data.schedule as CareSchedule;
        }
      } else if (parsed) {
        logger.warn('GPT routine failed validation — backfilling curated', parsed.error.issues);
      }
    } catch (err) {
      logger.error('GPT routine generation errored — backfilling curated', err);
    }
  }

  // Assemble in selected order: GPT step where we got one, curated otherwise.
  // Always pad to 3 tips so the free/premium (1 + 2) gate stays consistent.
  const steps = selected
    .map((key) => {
      const step = gptSteps.get(key) ?? curatedStep(key);
      if (!step) return undefined;
      return { ...step, tips: ensureThreeTips(key, step.tips) };
    })
    .filter((s): s is RoutineStep => !!s);

  if (steps.length === 0) return buildEyeRoutine(analysis, concerns);
  const routine: EyeRoutine = {
    intro,
    steps,
    schedule: mergeSchedule(gptSchedule, fallbackSchedule),
  };
  if (cacheKey) await writeRoutineCache(cacheKey, routine);
  return routine;
}
