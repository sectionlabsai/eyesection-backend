import { EyeScan } from '../../models/EyeScan';
import { User } from '../../models/User';
import { AppError } from '../../middleware/error';
import { logger } from '../../utils/logger';
import { env } from '../../config/env';
import { getObjectBuffer, uploadBuffer, scanKey } from '../s3.service';
import { makeDisplayThumb } from '../image.service';
import { extractEyeRegionJpeg } from './eyeCrop.service';
import {
  computeLab,
  DARK_CIRCLE_CUTOFFS,
  REDNESS_CUTOFFS,
  FINELINES_CUTOFFS,
  DULLNESS_CUTOFFS,
} from './lab.service';
import { classifyWithGpt, fallbackFromLab } from './gpt.service';
import { invalidateChatContext } from '../chatCache';
import { ScanGeometry, ReconciledAnalysis } from './types';
import { computeFreshness } from '../scoring/freshness.service';
import {
  severityFromValue,
  levelFromSeverity,
  blendSeverity,
  gptWeightFromConfidence,
  severityToSubScore,
} from '../scoring/severity.service';
import { classifyIris } from '../scoring/iris.service';
import { generateEyeRoutine } from '../recommend/gptRoutine.service';
import { trigger } from '../notification.service';

/** Left/right openness balance → 0..1 symmetry (1 = balanced). */
function deriveSymmetry(geometry: ScanGeometry): number {
  if (typeof geometry.symmetry === 'number') {
    return Math.max(0, Math.min(1, geometry.symmetry));
  }
  const l = geometry.eyeOpennessL;
  const r = geometry.eyeOpennessR;
  if (typeof l === 'number' && typeof r === 'number' && Math.max(l, r) > 0) {
    return Math.max(0, 1 - Math.abs(l - r) / Math.max(l, r));
  }
  return 0.8; // neutral default when openness isn't provided
}

function hasEyeRegion(geometry: ScanGeometry): boolean {
  if (!geometry) return false;
  const hasOpenness =
    typeof geometry.eyeOpennessL === 'number' || typeof geometry.eyeOpennessR === 'number';
  const hasCrops = !!geometry.crops && Object.keys(geometry.crops).length > 0;
  return hasOpenness || hasCrops;
}

/**
 * The `analyze-eye-scan` worker body. Runs LAB analysis + GPT classification in
 * parallel, reconciles, scores in code, classifies the iris, builds a routine,
 * and persists. Provider/internal errors set status 'failed' with an internal
 * errorReason and are NEVER surfaced to the user.
 */
export async function processScan(scanId: string): Promise<void> {
  const scan = await EyeScan.findById(scanId);
  if (!scan) {
    logger.warn(`processScan: scan ${scanId} not found`);
    return;
  }

  scan.status = 'processing';
  await scan.save();

  try {
    const geometry = (scan.geometryRaw ?? scan.geometry ?? {}) as ScanGeometry;

    // Hard guard — client should prevent this, but double-check.
    if (!hasEyeRegion(geometry)) {
      throw new AppError(422, "We couldn't read the eyes in that photo", 'NO_EYE_REGION');
    }

    const rawKey = scan.images.front.raw;
    if (!rawKey) {
      throw new AppError(410, 'The photo for this scan is no longer available', 'IMAGE_EXPIRED');
    }
    const imageBuffer = await getObjectBuffer(rawKey);

    // Isolate the eye region once. This crop is both what the vision model
    // grades (high detail) and the ONLY image shown back to the user — the
    // full-face photo is never displayed in the app.
    const eyeCrop = await extractEyeRegionJpeg(imageBuffer, geometry);

    // Run the local LAB analysis and the vision-model ensemble concurrently:
    // the model call no longer depends on the LAB result (only the code-only
    // fallback does), so the multi-second GPT round overlaps the LAB pixel math
    // instead of waiting for it. The fallback is applied here if the model was
    // unavailable — LAB is guaranteed resolved by then.
    const [lab, gptResult] = await Promise.all([
      computeLab(imageBuffer, geometry),
      classifyWithGpt(imageBuffer, geometry, eyeCrop),
    ]);
    const gpt = gptResult ?? fallbackFromLab(lab);

    // Never present fabricated fallback defaults as a real result: when a vision
    // model IS configured but the ensemble couldn't be reached, fail the scan
    // (the user is asked to retry) instead of saving code-only neutral levels.
    if (gpt.source === 'fallback' && env.OPENAI_API_KEY) {
      throw new AppError(
        503,
        "We couldn't finish analyzing your scan. Please try again in a moment.",
        'ANALYSIS_UNAVAILABLE',
      );
    }

    // Continuous severity per metric (EB-06). Dark circles + redness anchor the
    // model's read to the LAB pixel magnitude; puffiness + tired look come
    // straight from the model's numeric read. The displayed level is derived
    // from the final severity, so badge and score always agree.
    const gptWeight = gpt.source === 'gpt' ? gptWeightFromConfidence(gpt.confidence) : 0;

    const darkSeverity = blendSeverity(
      severityFromValue(lab.darkCircleLDelta, DARK_CIRCLE_CUTOFFS),
      gpt.darkCircles,
      gptWeight,
    );
    const rednessSeverity = blendSeverity(
      severityFromValue(lab.rednessAValue, REDNESS_CUTOFFS),
      gpt.redness,
      gptWeight,
    );
    const puffinessSeverity = gpt.puffiness;
    const tiredSeverity = gpt.tiredLook;
    // Fine lines + radiance-dullness both have a genuine code measurement, so they
    // blend the LAB/texture read with the model exactly like dark circles/redness.
    const fineLinesSeverity = blendSeverity(
      severityFromValue(lab.textureValue, FINELINES_CUTOFFS),
      gpt.fineLines,
      gptWeight,
    );
    const dullnessSeverity = blendSeverity(
      severityFromValue(lab.dullnessValue, DULLNESS_CUTOFFS),
      gpt.dullness,
      gptWeight,
    );
    const symmetry = deriveSymmetry(geometry);

    const darkLevel = levelFromSeverity(darkSeverity);
    const rednessLevel = levelFromSeverity(rednessSeverity);
    const puffinessLevel = levelFromSeverity(puffinessSeverity);
    const tiredLevel = levelFromSeverity(tiredSeverity);
    const fineLinesLevel = levelFromSeverity(fineLinesSeverity);
    // Radiance stores its DULLNESS level (none = not dull = radiant) so `none`
    // reads as "Good" on the client, consistent with every other metric.
    const radianceLevel = levelFromSeverity(dullnessSeverity);

    const reconciled: ReconciledAnalysis = {
      darkCircles: { level: darkLevel, lDelta: lab.darkCircleLDelta },
      puffiness: { level: puffinessLevel },
      redness: { level: rednessLevel, aValue: lab.rednessAValue },
      tiredLook: { level: tiredLevel },
      fineLines: { level: fineLinesLevel, textureValue: lab.textureValue },
      radiance: { level: radianceLevel, dullnessValue: lab.dullnessValue },
      symmetry,
    };

    const subScores = {
      darkCircles: severityToSubScore(darkSeverity),
      puffiness: severityToSubScore(puffinessSeverity),
      tiredLook: severityToSubScore(tiredSeverity),
      redness: severityToSubScore(rednessSeverity),
      fineLines: severityToSubScore(fineLinesSeverity),
      radiance: severityToSubScore(dullnessSeverity), // high sub-score = radiant
      symmetry: Math.round(symmetry * 100),
    };
    const freshness = computeFreshness(subScores);

    const iris = await classifyIris(lab.iris);

    const user = scan.userId
      ? await User.findById(scan.userId).select(
          'concerns goal careProducts baselineComfort screenProfile',
        )
      : null;
    const concerns = user?.concerns ?? [];
    const routine = await generateEyeRoutine(
      {
        darkCircles: { level: darkLevel, severity: darkSeverity },
        puffiness: { level: puffinessLevel, severity: puffinessSeverity },
        redness: { level: rednessLevel, severity: rednessSeverity },
        tiredLook: { level: tiredLevel, severity: tiredSeverity },
        fineLines: { level: fineLinesLevel, severity: fineLinesSeverity },
        // Radiance tips key off dullness level; symmetry tips key off imbalance.
        radiance: { level: radianceLevel, severity: dullnessSeverity },
        symmetry: {
          level:
            symmetry >= 0.85 ? 'none' : symmetry >= 0.7 ? 'mild' : symmetry >= 0.55 ? 'moderate' : 'high',
          severity: 1 - symmetry,
        },
      },
      concerns,
      {
        goal: user?.goal,
        careProducts: user?.careProducts,
        baselineComfort: user?.baselineComfort,
        dailyScreenHours: user?.screenProfile?.dailyScreenHours,
        nightPhoneUse: user?.screenProfile?.nightPhoneUse,
      },
    );

    scan.analysis = {
      freshnessScore: freshness.freshnessScore,
      band: freshness.band,
      darkCircles: reconciled.darkCircles,
      puffiness: reconciled.puffiness,
      redness: reconciled.redness,
      tiredLook: reconciled.tiredLook,
      fineLines: reconciled.fineLines,
      radiance: reconciled.radiance,
      symmetryScore: Math.round(symmetry * 100),
      subScores: { ...freshness.subScores },
      routine,
    };
    // Only surface an iris colour we actually trust — a low-confidence guess
    // (mostly-pupil crop, no chroma) is left unset rather than shown wrong.
    if (iris.result && iris.reason === 'ok') {
      scan.iris = {
        colorCategory: iris.result.colorCategory,
        colorName: iris.result.colorName,
        hex: iris.result.hex,
        description: iris.result.description,
        styling: iris.result.styling,
      };
    } else {
      logger.info(`Scan ${scanId} iris not set — reason: ${iris.reason}`);
    }
    // Store raw model + code values for audit (never shown to users).
    scan.aiRaw = {
      gpt,
      lab,
      reconciled,
      gptConfidence: gpt.confidence,
      gptWeight,
      severities: {
        darkCircles: darkSeverity,
        puffiness: puffinessSeverity,
        tiredLook: tiredSeverity,
        redness: rednessSeverity,
        fineLines: fineLinesSeverity,
        radiance: dullnessSeverity,
        symmetry: 1 - symmetry,
      },
      iris: { hsl: lab.iris, reason: iris.reason },
    };

    // Persist a display thumbnail of the eye crop (best-effort — a display-image
    // failure must never fail an otherwise-complete scan). This is the only scan
    // image the app ever shows; the full-face thumb stays admin-only.
    if (eyeCrop) {
      try {
        const eyeThumb = await makeDisplayThumb(eyeCrop);
        if (eyeThumb) {
          const ownerId = scan.userId?.toString() ?? 'anon';
          const eyeThumbKey = scanKey(ownerId, scan._id.toString(), 'front', 'eye-thumb');
          await uploadBuffer(eyeThumbKey, eyeThumb, 'image/jpeg');
          scan.images.front.eyeThumb = eyeThumbKey;
        }
      } catch (err) {
        logger.warn(`Scan ${scanId} eye-thumb persist failed`, err);
      }
    }

    scan.status = 'complete';
    scan.errorReason = undefined;
    await scan.save();

    logger.info(
      `Scan ${scanId} complete — freshness ${freshness.freshnessScore} (${freshness.band}), gpt=${gpt.source}`,
    );

    // "Results ready" transactional push (EB-11 catalog). Fire-and-forget so a
    // push failure never affects the completed scan; no-ops for anonymous scans
    // and for users with no registered device tokens.
    if (scan.userId) {
      const uid = scan.userId.toString();
      void trigger('ResultsReady', uid).catch((err) =>
        logger.error(`ResultsReady push failed for scan ${scanId}`, err),
      );
      // New findings change the chat's context snapshot — drop the cache so the
      // assistant references this scan immediately. Fire-and-forget, fails open.
      void invalidateChatContext(uid);
    }
  } catch (err) {
    // Friendly internal reason only; the provider/error detail never leaks.
    const reason =
      err instanceof AppError ? err.message : 'Analysis failed while processing the photo';
    scan.status = 'failed';
    scan.errorReason = reason;
    await scan.save();
    logger.error(`Scan ${scanId} failed`, err);

    // "Scan failed" transactional push — nudge the user to retake. Same
    // fire-and-forget / anonymous-safe handling as the success path.
    if (scan.userId) {
      const uid = scan.userId.toString();
      void trigger('ScanFailed', uid).catch((pushErr) =>
        logger.error(`ScanFailed push failed for scan ${scanId}`, pushErr),
      );
    }
  }
}
