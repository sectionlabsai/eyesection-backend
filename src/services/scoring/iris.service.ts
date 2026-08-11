import { IrisColor } from '../../models/IrisColor';
import { IrisSample } from '../../utils/color';
import { logger } from '../../utils/logger';

export interface IrisResult {
  colorCategory: string;
  colorName: string;
  hex: string;
  description: string;
  styling: unknown;
  confidence: number; // 0..1
}

/** Why iris classification produced (or failed to produce) a result — audit only. */
export type IrisReason =
  | 'ok'
  | 'no_iris_crop' // geometry had no sampleable iris pixels
  | 'reference_not_seeded' // IrisColor collection empty (run `npm run seed:iris`)
  | 'low_confidence'; // sampled colour was too ambiguous to name confidently

export interface IrisClassification {
  result: IrisResult | null;
  reason: IrisReason;
}

/**
 * Map dominant iris HSL to the nearest IrisColor category, then hydrate the
 * friendly name/hex/styling from the seeded reference collection (EB-02).
 * Cosmetic/informational only. Ambiguous inputs get a lower confidence.
 */
function categoryFromHsl(hsl: { h: number; s: number; l: number }): {
  category: string;
  confidence: number;
} {
  const { h, s, l } = hsl;
  const warm = h < 75 || h > 300; // red–orange–yellow band → brown / amber / hazel
  const cool = h >= 175 && h <= 260; // blue band
  const green = h >= 75 && h < 175;

  // Near-neutral: almost no colour signal. A light crop is genuinely grey; a
  // darker one is a deep iris we simply couldn't pull colour from → deep brown.
  if (s < 0.1) {
    return l < 0.45
      ? { category: 'deep_brown', confidence: 0.55 }
      : { category: 'grey', confidence: 0.8 };
  }

  // Weak-but-real colour (0.1 ≤ s < 0.2). The hue still carries meaning, so do
  // NOT blanket-grey it (the old code did, turning a washed-out brown grey). A
  // warm hue here is a desaturated brown; a cool hue is only trusted as blue
  // when the eye is also light — otherwise it's a brown reading cool off a
  // reflection, so fall back to lightness.
  if (s < 0.2) {
    if (warm) {
      return l < 0.5
        ? { category: 'deep_brown', confidence: 0.7 }
        : { category: 'amber', confidence: 0.55 };
    }
    if (green) return { category: 'green', confidence: 0.55 };
    if (cool && l >= 0.5) return { category: 'ocean_blue', confidence: 0.55 };
    return l < 0.5
      ? { category: 'deep_brown', confidence: 0.5 }
      : { category: 'grey', confidence: 0.6 };
  }

  // Confident saturation — trust the hue.
  if (cool) return { category: 'ocean_blue', confidence: 0.8 };
  if (green) return { category: 'green', confidence: 0.75 };
  if (warm) {
    if (l < 0.32) return { category: 'deep_brown', confidence: 0.85 };
    if (l < 0.5 && s < 0.45) return { category: 'warm_hazel', confidence: 0.65 };
    return { category: 'amber', confidence: 0.7 };
  }

  // Magenta/purple region is unusual for irises — nearest is deep brown, low conf.
  return { category: 'deep_brown', confidence: 0.4 };
}

/**
 * Below this we still return the colour but flag it as low-confidence (and the
 * pipeline leaves it unset). Tuned so a dark-brown eye reliably shows while a
 * genuinely unreadable, near-colourless crop still abstains.
 */
const MIN_IRIS_CONFIDENCE = 0.4;

export async function classifyIris(iris: IrisSample | null): Promise<IrisClassification> {
  if (!iris) return { result: null, reason: 'no_iris_crop' };

  const { category, confidence } = categoryFromHsl(iris);
  const doc =
    (await IrisColor.findOne({ category })) || (await IrisColor.findOne({ category: 'deep_brown' }));

  if (!doc) {
    // Seed missing — don't crash the pipeline over a cosmetic feature.
    logger.warn('IrisColor reference not seeded; run `npm run seed:iris`');
    return { result: null, reason: 'reference_not_seeded' };
  }

  // Scale confidence by how much real colour the crop actually carried: a crop
  // that was almost all pupil/sclera can't be trusted to name a colour. Full
  // trust once ~25%+ of kept pixels were chromatic; below ~15% it still abstains.
  const signalStrength = Math.max(0, Math.min(1, iris.chromaticFraction / 0.25));
  const base = doc.category === category ? confidence : Math.min(confidence, 0.4);
  const finalConfidence = base * signalStrength;

  return {
    result: {
      colorCategory: doc.category,
      colorName: doc.name,
      hex: doc.hex,
      description: doc.description,
      styling: doc.styling,
      confidence: finalConfidence,
    },
    reason: finalConfidence < MIN_IRIS_CONFIDENCE ? 'low_confidence' : 'ok',
  };
}
