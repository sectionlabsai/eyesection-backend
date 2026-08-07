/**
 * Distils the vision model's ensemble read from accumulated scans into calibrated
 * LAB/texture level cutoffs — label-free threshold tuning (no human raters).
 *
 * For each code-measured metric (dark-circle L-delta, redness a-delta, fine-line
 * texture energy, radiance dullness) it derives a discrete label from the stored
 * continuous GPT severity, then grid-searches the three ascending cutoffs that
 * minimise mean absolute rank error against those labels and prints the
 * recommended env overrides next to the active ones.
 *
 * Read-only — changes nothing until you set the env vars. Re-run as scans
 * accumulate: `npm run calibrate:thresholds`.
 */
import { connectDB, disconnectDB } from '../config/db';
import { EyeScan } from '../models/EyeScan';
import { Level, LEVELS } from '../types/levels';
import {
  DARK_CIRCLE_CUTOFFS,
  REDNESS_CUTOFFS,
  FINELINES_CUTOFFS,
  DULLNESS_CUTOFFS,
} from '../services/analysis/lab.service';
import { levelFromSeverity } from '../services/scoring/severity.service';
import { logger } from '../utils/logger';

const MIN_POINTS = 50; // below this, recommendations would overfit noise
const MIN_CONFIDENCE = 0.6; // only trust labels the vote ensemble agreed on
const RANK: Record<Level, number> = { none: 0, mild: 1, moderate: 2, high: 3 };

type Cutoffs = [number, number, number];

interface Point {
  value: number;
  labelRank: number;
}

interface AiRawShape {
  gpt?: {
    darkCircles?: number;
    redness?: number;
    fineLines?: number;
    dullness?: number;
    source?: string;
    confidence?: number;
  };
  lab?: {
    darkCircleLDelta?: number;
    rednessAValue?: number;
    textureValue?: number;
    dullnessValue?: number;
  };
}

function rankFor(value: number, cutoffs: Cutoffs): number {
  if (value < cutoffs[0]) return 0;
  if (value < cutoffs[1]) return 1;
  if (value < cutoffs[2]) return 2;
  return 3;
}

/** Mean absolute rank error of these cutoffs against the GPT labels. */
function meanAbsError(points: Point[], cutoffs: Cutoffs): number {
  let total = 0;
  for (const p of points) total += Math.abs(rankFor(p.value, cutoffs) - p.labelRank);
  return total / points.length;
}

function exactAgreement(points: Point[], cutoffs: Cutoffs): number {
  let hits = 0;
  for (const p of points) if (rankFor(p.value, cutoffs) === p.labelRank) hits += 1;
  return hits / points.length;
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[idx];
}

/** Candidate cutoffs = value percentiles every 2% (deduped, rounded to 0.1). */
function candidates(sorted: number[]): number[] {
  const out = new Set<number>();
  for (let p = 2; p <= 98; p += 2) {
    out.add(Math.round(percentile(sorted, p) * 10) / 10);
  }
  return [...out].sort((a, b) => a - b);
}

function bestCutoffs(points: Point[]): Cutoffs {
  const sorted = points.map((p) => p.value).sort((a, b) => a - b);
  const cand = candidates(sorted);

  let best: Cutoffs = [cand[0] ?? 0, cand[1] ?? 1, cand[2] ?? 2];
  let bestErr = Infinity;
  for (let i = 0; i < cand.length - 2; i += 1) {
    for (let j = i + 1; j < cand.length - 1; j += 1) {
      for (let k = j + 1; k < cand.length; k += 1) {
        const c: Cutoffs = [cand[i], cand[j], cand[k]];
        const err = meanAbsError(points, c);
        if (err < bestErr) {
          bestErr = err;
          best = c;
        }
      }
    }
  }
  return best;
}

function report(name: string, envVar: string, points: Point[], current: Cutoffs): void {
  logger.info(`\n── ${name} ──`);
  if (points.length < MIN_POINTS) {
    logger.info(
      `  Only ${points.length} high-confidence labeled scans (need ${MIN_POINTS}). ` +
        `Keep collecting — no recommendation yet.`,
    );
    return;
  }

  const sorted = points.map((p) => p.value).sort((a, b) => a - b);
  const pcts = [10, 25, 50, 75, 90]
    .map((p) => `p${p}=${percentile(sorted, p).toFixed(1)}`)
    .join('  ');
  logger.info(`  ${points.length} labeled scans · value distribution: ${pcts}`);

  const labelMix = LEVELS.map(
    (l) => `${l}=${points.filter((p) => p.labelRank === RANK[l]).length}`,
  ).join('  ');
  logger.info(`  GPT label mix: ${labelMix}`);

  const best = bestCutoffs(points);
  const fmt = (c: Cutoffs): string => c.map((v) => v.toFixed(1)).join(',');
  logger.info(
    `  active  [${fmt(current)}] → agreement ${(exactAgreement(points, current) * 100).toFixed(1)}%` +
      ` · mean rank error ${meanAbsError(points, current).toFixed(3)}`,
  );
  logger.info(
    `  best    [${fmt(best)}] → agreement ${(exactAgreement(points, best) * 100).toFixed(1)}%` +
      ` · mean rank error ${meanAbsError(points, best).toFixed(3)}`,
  );
  logger.info(`  To apply: ${envVar}=${fmt(best)}`);
}

async function main(): Promise<void> {
  await connectDB();

  const scans = await EyeScan.find({ status: 'complete', aiRaw: { $ne: null } })
    .select('aiRaw')
    .lean();

  const dark: Point[] = [];
  const red: Point[] = [];
  const fine: Point[] = [];
  const dull: Point[] = [];

  // Discrete label derived from the stored continuous GPT severity.
  const labelRank = (severity: number | undefined): number | null =>
    typeof severity === 'number' ? RANK[levelFromSeverity(severity)] : null;
  const push = (arr: Point[], value: unknown, severity: number | undefined): void => {
    const rank = labelRank(severity);
    if (typeof value === 'number' && rank !== null) arr.push({ value, labelRank: rank });
  };

  for (const scan of scans) {
    const ai = scan.aiRaw as AiRawShape;
    const gpt = ai?.gpt;
    const lab = ai?.lab;
    if (!gpt || !lab || gpt.source !== 'gpt' || (gpt.confidence ?? 0) < MIN_CONFIDENCE) continue;

    push(dark, lab.darkCircleLDelta, gpt.darkCircles);
    push(red, lab.rednessAValue, gpt.redness);
    push(fine, lab.textureValue, gpt.fineLines);
    push(dull, lab.dullnessValue, gpt.dullness);
  }

  logger.info(`Calibration source: ${scans.length} completed scans with stored aiRaw.`);
  report('Dark circles (L-delta)', 'DARK_CIRCLE_THRESHOLDS', dark, DARK_CIRCLE_CUTOFFS);
  report('Redness (a-delta)', 'REDNESS_THRESHOLDS', red, REDNESS_CUTOFFS);
  report('Fine lines (texture energy)', 'FINELINES_THRESHOLDS', fine, FINELINES_CUTOFFS);
  report('Radiance (dullness)', 'RADIANCE_THRESHOLDS', dull, DULLNESS_CUTOFFS);

  await disconnectDB();
}

main().catch((err) => {
  logger.error('calibrate:thresholds failed', err);
  process.exit(1);
});
