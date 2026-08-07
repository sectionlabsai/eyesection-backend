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

  // Low saturation: a LIGHT crop is genuinely grey; a DARK one is far more
  // likely a deep iris we couldn't pull colour from than a truly grey eye —
  // so default dark+colourless to deep brown, not grey.
  if (s < 0.18) {
    if (l < 0.4) return { category: 'deep_brown', confidence: 0.55 };
    return { category: 'grey', confidence: s < 0.1 ? 0.8 : 0.55 };
  }

  // Blue / ocean: cool hues.
  if (h >= 175 && h <= 260) {
    return { category: 'ocean_blue', confidence: 0.8 };
  }

  // Green: yellow-green through green.
  if (h >= 75 && h < 175) {
    return { category: 'green', confidence: 0.75 };
  }

  // Warm browns / amber / hazel live in the red-orange-yellow band.
  if (h < 75 || h > 300) {
    if (l < 0.3) return { category: 'deep_brown', confidence: 0.85 };
    if (l >= 0.3 && l < 0.45 && s < 0.45) return { category: 'warm_hazel', confidence: 0.65 };
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
