import OpenAI from 'openai';
import { z } from 'zod';
import { env } from '../../config/env';
import { logger } from '../../utils/logger';
import { extractEyeRegionJpeg } from './eyeCrop.service';
import { GptClassification, LabAnalysis, ScanGeometry } from './types';

/**
 * Layer 3 — vision-model APPEARANCE read (EB-05). The model returns a continuous
 * 0..100 intensity per cosmetic attribute for THIS specific scan; the code layer
 * turns those into scores and (for dark circles + redness) anchors them to the
 * pixel measurement. The model still NEVER names or hints at any eye/vision
 * condition — appearance only.
 *
 * Accuracy design:
 *  - Two images per call: the full face at low detail (lighting / baseline
 *    skin-tone context) and the eye-region crop at high detail.
 *  - A written rubric anchors the 0/33/66/100 points so the scale doesn't drift.
 *  - Strict structured outputs make malformed JSON impossible.
 *  - SAMPLES parallel calls, averaged per attribute; `confidence` is the
 *    cross-sample agreement (tight spread = high confidence), NOT the model's
 *    self-report. Provider errors fall back to code-only values and are NEVER
 *    surfaced to the user.
 *
 * No `temperature` is sent: the GPT-5.x models reject anything but the default,
 * and default sampling already gives the ensemble its spread.
 */

const SAMPLES = 3;

const SYSTEM_PROMPT = `You are a COSMETIC eye-area appearance rater for a beauty & wellness app.
You are given a close-up crop of the person's eye region (which includes the lids,
brows and the top of the cheek for an under-eye vs cheek comparison). Judge only
from this close-up.

STRICT RULES — you must follow every one:
- You are NOT a doctor and this is NOT medical. Never diagnose, name, screen for,
  or hint at ANY eye or vision condition (no glaucoma, dry eye, infection, etc.) —
  not even to rule one out.
- Redness is an APPEARANCE only, never a symptom.
- Return ONLY a JSON object, no prose.

For each attribute return an INTEGER 0-100 intensity for how strongly it appears
in THIS person's eye area. Use the whole scale precisely — 0 means truly absent,
100 means as strong as it realistically gets. These anchors calibrate the scale:
  0 = none · ~30 = mild/subtle · ~65 = clearly present/moderate · ~90+ = strong.
Report the precise value you actually see — e.g. 18, 44, 72 — not just the anchors.

PUFFINESS (lower-lid fullness): 0 flat lid · mild faint bag edge · moderate a
  clearly visible bag with a crease · strong pronounced swelling reshaping the eye.
TIRED LOOK (overall fatigue impression): 0 rested & bright · mild slight heaviness
  · moderate clearly heavy/dull lids with shadowing · strong markedly fatigued.
DARK CIRCLES (under-eye darkening vs the person's OWN cheek): 0 matches cheek ·
  mild slight darkening · moderate a defined darker half-moon · strong deep discoloration.
REDNESS (visible red/pink appearance): 0 none · mild faint pinkness/few vessels ·
  moderate clearly visible redness · strong strongly red area.
FINE LINES (fine-line / crease appearance of the eye-area skin, incl. the outer
  corner "crow's feet"): 0 perfectly smooth skin · mild one or two faint lines ·
  moderate several clearly visible fine lines · strong many deep creases. This is a
  cosmetic skin-texture appearance ONLY — never framed as aging or a condition.
DULLNESS (opposite of a radiant, luminous look): 0 bright, fresh, luminous skin ·
  mild slightly flat · moderate clearly dull/lacklustre · strong very flat and dull.
  Rate DULLNESS (higher = duller); a glowing, well-rested eye area scores low.

Judge each attribute independently — do not let one influence another. Report what
you see for THIS person, not a cautious middle.

Return exactly this shape:
{"puffiness":0-100,"tiredLook":0-100,"darkCircles":0-100,"redness":0-100,"fineLines":0-100,"dullness":0-100}`;

const metricInt = { type: 'integer', minimum: 0, maximum: 100 } as const;
const RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'eye_area_intensities',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['puffiness', 'tiredLook', 'darkCircles', 'redness', 'fineLines', 'dullness'],
      properties: {
        puffiness: metricInt,
        tiredLook: metricInt,
        darkCircles: metricInt,
        redness: metricInt,
        fineLines: metricInt,
        dullness: metricInt,
      },
    },
  },
} as const;

const score = z.coerce.number().min(0).max(100);
const responseSchema = z.object({
  puffiness: score,
  tiredLook: score,
  darkCircles: score,
  redness: score,
  fineLines: score,
  dullness: score,
});

type Sample = z.infer<typeof responseSchema>;
const METRICS = ['puffiness', 'tiredLook', 'darkCircles', 'redness', 'fineLines', 'dullness'] as const;

let client: OpenAI | null = null;
function getClient(): OpenAI | null {
  if (!env.OPENAI_API_KEY) return null;
  if (!client) client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  return client;
}

/** Code-only read derived from LAB values — used only when no model is configured. */
export function fallbackFromLab(lab: LabAnalysis): GptClassification {
  return {
    puffiness: 0.33, // no code measure — neutral default
    tiredLook: 0.33,
    darkCircles: Math.min(1, lab.darkCircleLDelta / 18),
    redness: Math.min(1, lab.rednessAValue / 14),
    fineLines: Math.min(1, lab.textureValue / 28),
    dullness: Math.min(1, lab.dullnessValue / 100),
    confidence: 0.4,
    source: 'fallback',
  };
}

type ImageContent = Array<
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail: 'low' | 'high' } }
>;

function buildContent(fullBase64: string, eyeCropBase64: string | null): ImageContent {
  const content: ImageContent = [
    { type: 'text', text: 'Rate the eye-area appearance intensities (0-100) for this person.' },
  ];
  if (eyeCropBase64) {
    // Grade strictly from the high-detail eye crop. The full face is deliberately
    // NOT sent — the crop already includes lids, brows and the upper cheek.
    content.push({
      type: 'image_url',
      image_url: { url: `data:image/jpeg;base64,${eyeCropBase64}`, detail: 'high' },
    });
  } else {
    // No geometry crop available — fall back to the full photo at high detail.
    content.push({
      type: 'image_url',
      image_url: { url: `data:image/jpeg;base64,${fullBase64}`, detail: 'high' },
    });
  }
  return content;
}

async function callOnce(content: ImageContent): Promise<Sample | null> {
  const openai = getClient();
  if (!openai) return null;

  const res = await openai.chat.completions.create({
    model: env.OPENAI_MODEL,
    response_format: RESPONSE_FORMAT,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content },
    ],
  });

  const raw = res.choices[0]?.message?.content;
  if (!raw) return null;

  const parsed = responseSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    logger.warn('Vision rating failed schema validation', parsed.error.issues);
    return null;
  }
  return parsed.data;
}

function stddev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
}

/**
 * Average the ensemble into a continuous per-metric severity (0..1), with
 * confidence from how tightly the samples agreed (a spread of 0.5 on the 0..1
 * scale → zero confidence). Exported for testing.
 */
export function aggregate(samples: Sample[]): GptClassification {
  const meanSeverity = (m: (typeof METRICS)[number]): number =>
    samples.reduce((a, s) => a + s[m], 0) / samples.length / 100;

  const avgSpread =
    METRICS.reduce((a, m) => a + stddev(samples.map((s) => s[m] / 100)), 0) / METRICS.length;
  let confidence = Math.max(0, Math.min(1, 1 - 2 * avgSpread));
  if (samples.length < 2) confidence = Math.min(confidence, 0.5); // no cross-check

  return {
    puffiness: meanSeverity('puffiness'),
    tiredLook: meanSeverity('tiredLook'),
    darkCircles: meanSeverity('darkCircles'),
    redness: meanSeverity('redness'),
    fineLines: meanSeverity('fineLines'),
    dullness: meanSeverity('dullness'),
    confidence: Math.round(confidence * 100) / 100,
    source: 'gpt',
  };
}

/** One round of SAMPLES parallel calls → the samples that parsed cleanly. */
async function gatherSamples(content: ImageContent): Promise<Sample[]> {
  const results = await Promise.allSettled(
    Array.from({ length: SAMPLES }, () => callOnce(content)),
  );
  const samples: Sample[] = [];
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value) samples.push(r.value);
    else if (r.status === 'rejected') logger.error('Vision rating sample errored', r.reason);
  }
  return samples;
}

/**
 * Rate eye-area appearance by averaging SAMPLES parallel calls, retrying the
 * whole round once to survive a transient provider blip.
 *
 * Returns `null` when no vision model is configured or every attempt fails —
 * the caller supplies the code-only fallback (`fallbackFromLab`). Decoupling the
 * fallback from this call means the model request no longer depends on the LAB
 * result, so the pipeline can run LAB analysis and this vision call in parallel.
 * Provider errors are swallowed here and must NEVER reach the user.
 */
export async function classifyWithGpt(
  imageBuffer: Buffer,
  geometry: ScanGeometry,
  precomputedCrop?: Buffer | null,
): Promise<GptClassification | null> {
  const openai = getClient();
  if (!openai) {
    logger.warn('OPENAI_API_KEY not set — using code-only classification');
    return null;
  }

  // Reuse the crop the pipeline already extracted (it persists it for display);
  // only re-extract when a caller didn't provide one.
  const eyeCrop =
    precomputedCrop !== undefined
      ? precomputedCrop
      : await extractEyeRegionJpeg(imageBuffer, geometry);
  const content = buildContent(
    imageBuffer.toString('base64'),
    eyeCrop ? eyeCrop.toString('base64') : null,
  );

  for (let round = 1; round <= 2; round += 1) {
    const samples = await gatherSamples(content);
    if (samples.length > 0) return aggregate(samples);
    if (round < 2) {
      logger.warn('Vision round 1 produced no samples — retrying once');
      await new Promise((resolve) => setTimeout(resolve, 600));
    }
  }

  logger.warn('Vision rating unavailable — caller will fall back to code-only values');
  return null;
}
