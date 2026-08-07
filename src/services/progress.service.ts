import { Types } from 'mongoose';
import { EyeScan, IEyeScan } from '../models';
import { AppError } from '../middleware/error';
import { getSignedUrl } from './s3.service';
import { Level, LEVEL_SEVERITY } from '../types/levels';

/**
 * Freshness score trend from the user's completed scans over a date range.
 * Points are oldest → newest so the client can plot them directly.
 */
export async function freshnessTrend(
  userId: string,
  rangeDays: number,
): Promise<{ range: number; points: Record<string, unknown>[] }> {
  const since = new Date(Date.now() - rangeDays * 24 * 60 * 60 * 1000);
  const scans = await EyeScan.find({
    userId: new Types.ObjectId(userId),
    status: 'complete',
    'analysis.freshnessScore': { $exists: true },
    createdAt: { $gte: since },
  })
    .select('analysis.freshnessScore analysis.band createdAt')
    .sort({ createdAt: 1 });

  const points = scans.map((s) => ({
    scanId: s._id.toString(),
    date: s.createdAt,
    freshnessScore: s.analysis?.freshnessScore,
    band: s.analysis?.band,
  }));

  return { range: rangeDays, points };
}

/** Severity direction between two discrete levels (from the user's view). */
function levelTrend(before: Level, after: Level): 'improved' | 'same' | 'worse' {
  const d = LEVEL_SEVERITY[after] - LEVEL_SEVERITY[before];
  if (d < 0) return 'improved'; // less severe = better
  if (d > 0) return 'worse';
  return 'same';
}

interface MetricDelta {
  before: Level | number;
  after: Level | number;
  trend: 'improved' | 'same' | 'worse';
}

function numericTrend(
  before: number,
  after: number,
  higherIsBetter: boolean,
): 'improved' | 'same' | 'worse' {
  if (after === before) return 'same';
  const better = higherIsBetter ? after > before : after < before;
  return better ? 'improved' : 'worse';
}

async function scanThumb(scan: IEyeScan): Promise<string | null> {
  // Eyes-only: expose the eye-region crop, never the full-face thumbnail.
  return scan.images.front?.eyeThumb ? getSignedUrl(scan.images.front.eyeThumb) : null;
}

/**
 * Premium before/after: earliest vs latest completed scan, with signed
 * thumbnails and per-metric deltas. Needs at least two completed scans.
 */
export async function beforeAfter(userId: string): Promise<Record<string, unknown>> {
  const filter = {
    userId: new Types.ObjectId(userId),
    status: 'complete' as const,
    'analysis.freshnessScore': { $exists: true },
  };

  const [earliest, latest] = await Promise.all([
    EyeScan.findOne(filter).sort({ createdAt: 1 }),
    EyeScan.findOne(filter).sort({ createdAt: -1 }),
  ]);

  if (!earliest || !latest || earliest._id.equals(latest._id)) {
    throw new AppError(
      422,
      'Take at least two scans to see your before-and-after',
      'NOT_ENOUGH_SCANS',
    );
  }

  const b = earliest.analysis!;
  const a = latest.analysis!;

  const metrics: Record<string, MetricDelta> = {
    freshnessScore: {
      before: b.freshnessScore,
      after: a.freshnessScore,
      trend: numericTrend(b.freshnessScore, a.freshnessScore, true),
    },
    darkCircles: {
      before: b.darkCircles.level,
      after: a.darkCircles.level,
      trend: levelTrend(b.darkCircles.level, a.darkCircles.level),
    },
    puffiness: {
      before: b.puffiness.level,
      after: a.puffiness.level,
      trend: levelTrend(b.puffiness.level, a.puffiness.level),
    },
    redness: {
      before: b.redness.level,
      after: a.redness.level,
      trend: levelTrend(b.redness.level, a.redness.level),
    },
    tiredLook: {
      before: b.tiredLook.level,
      after: a.tiredLook.level,
      trend: levelTrend(b.tiredLook.level, a.tiredLook.level),
    },
    symmetryScore: {
      before: b.symmetryScore,
      after: a.symmetryScore,
      trend: numericTrend(b.symmetryScore, a.symmetryScore, true),
    },
  };

  const [beforeThumb, afterThumb] = await Promise.all([
    scanThumb(earliest),
    scanThumb(latest),
  ]);

  return {
    before: {
      scanId: earliest._id.toString(),
      date: earliest.createdAt,
      thumbUrl: beforeThumb,
      freshnessScore: b.freshnessScore,
      band: b.band,
    },
    after: {
      scanId: latest._id.toString(),
      date: latest.createdAt,
      thumbUrl: afterThumb,
      freshnessScore: a.freshnessScore,
      band: a.band,
    },
    metrics,
    freshnessDelta: a.freshnessScore - b.freshnessScore,
  };
}
