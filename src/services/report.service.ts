import { Types } from 'mongoose';
import { Report, IReport, EyeScan, ComfortEntry } from '../models';
import { localDayKey } from '../utils/day';

/** Monday 00:00 UTC of the week containing `d`. */
export function startOfWeekUTC(d: Date): Date {
  const out = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  );
  const dow = out.getUTCDay(); // 0 = Sun … 6 = Sat
  const backToMonday = (dow + 6) % 7;
  out.setUTCDate(out.getUTCDate() - backToMonday);
  return out;
}

/** The most recently completed week (previous Mon → Sun) as a UTC window. */
export function lastCompletedWeek(now = new Date()): { start: Date; end: Date } {
  const thisWeekStart = startOfWeekUTC(now);
  const start = new Date(thisWeekStart);
  start.setUTCDate(start.getUTCDate() - 7);
  return { start, end: thisWeekStart };
}

const round = (n: number): number => Math.round(n);
const avg = (nums: number[]): number =>
  nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;

export interface WeeklyStats {
  freshnessAvg: number;
  comfortAvg: number;
  bestDay?: string;
  worstDay?: string;
  breakCompliancePct: number;
  highlights: string[];
  hasData: boolean;
}

/** Kind, encouraging highlights (2-3) derived from the week's numbers. */
function buildHighlights(stats: {
  freshnessAvg: number;
  comfortAvg: number;
  breakCompliancePct: number;
  scanCount: number;
  entryCount: number;
}): string[] {
  const h: string[] = [];

  if (stats.entryCount > 0) {
    h.push(
      `You checked in on ${stats.entryCount} day${stats.entryCount === 1 ? '' : 's'} this week — lovely consistency.`,
    );
  }
  if (stats.comfortAvg >= 70) {
    h.push('Your eyes felt comfortable most of the week. Keep up the balanced habits.');
  } else if (stats.comfortAvg > 0) {
    h.push('A few more short breaks could help next week feel even easier on your eyes.');
  }
  if (stats.breakCompliancePct >= 60) {
    h.push(`Nice break habits — you kept your rhythm about ${stats.breakCompliancePct}% of the time.`);
  }
  if (stats.scanCount > 0 && stats.freshnessAvg > 0) {
    h.push(`Your average freshness this week was ${stats.freshnessAvg}. Every scan helps you spot trends.`);
  }

  if (h.length === 0) {
    h.push('A fresh week ahead — a quick daily check-in helps you feel the difference.');
  }
  return h.slice(0, 3);
}

/** Aggregate a user's activity for a week window into report fields. */
export async function computeWeeklyStats(
  userId: string,
  weekStart: Date,
  weekEnd: Date,
): Promise<WeeklyStats> {
  const uid = new Types.ObjectId(userId);

  const [scans, entries] = await Promise.all([
    EyeScan.find({
      userId: uid,
      status: 'complete',
      'analysis.freshnessScore': { $exists: true },
      createdAt: { $gte: weekStart, $lt: weekEnd },
    }).select('analysis.freshnessScore createdAt'),
    ComfortEntry.find({
      userId: uid,
      date: { $gte: weekStart, $lt: weekEnd },
    }).select('comfortScore inputs.breakCompliance date'),
  ]);

  const freshnessAvg = round(
    avg(scans.map((s) => s.analysis?.freshnessScore ?? 0)),
  );
  const comfortAvg = round(avg(entries.map((e) => e.comfortScore)));

  // Best/worst day by comfort score, keyed by UTC calendar day.
  let bestDay: string | undefined;
  let worstDay: string | undefined;
  let bestScore = -Infinity;
  let worstScore = Infinity;
  for (const e of entries) {
    const day = localDayKey(e.date, 'UTC');
    if (e.comfortScore > bestScore) {
      bestScore = e.comfortScore;
      bestDay = day;
    }
    if (e.comfortScore < worstScore) {
      worstScore = e.comfortScore;
      worstDay = day;
    }
  }

  // Break compliance is a 0-3 self-rating; express the week as a percentage.
  const breakCompliancePct = round(
    (avg(entries.map((e) => e.inputs?.breakCompliance ?? 0)) / 3) * 100,
  );

  const hasData = scans.length > 0 || entries.length > 0;

  return {
    freshnessAvg,
    comfortAvg,
    bestDay,
    worstDay,
    breakCompliancePct,
    highlights: buildHighlights({
      freshnessAvg,
      comfortAvg,
      breakCompliancePct,
      scanCount: scans.length,
      entryCount: entries.length,
    }),
    hasData,
  };
}

/**
 * Compute and persist the given week's report for a user (idempotent — one
 * report per user per week). Returns null if the user had no activity.
 */
export async function upsertWeeklyReport(
  userId: string,
  weekStart: Date,
  weekEnd: Date,
): Promise<IReport | null> {
  const stats = await computeWeeklyStats(userId, weekStart, weekEnd);
  if (!stats.hasData) return null;

  return Report.findOneAndUpdate(
    { userId: new Types.ObjectId(userId), weekStart },
    {
      $set: {
        freshnessAvg: stats.freshnessAvg,
        comfortAvg: stats.comfortAvg,
        bestDay: stats.bestDay,
        worstDay: stats.worstDay,
        breakCompliancePct: stats.breakCompliancePct,
        highlights: stats.highlights,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
}

function toView(r: IReport): Record<string, unknown> {
  return {
    weekStart: r.weekStart,
    freshnessAvg: r.freshnessAvg,
    comfortAvg: r.comfortAvg,
    bestDay: r.bestDay ?? null,
    worstDay: r.worstDay ?? null,
    breakCompliancePct: r.breakCompliancePct,
    highlights: r.highlights,
    createdAt: r.createdAt,
  };
}

export async function getLatest(
  userId: string,
): Promise<Record<string, unknown> | null> {
  const r = await Report.findOne({ userId: new Types.ObjectId(userId) }).sort({
    weekStart: -1,
  });
  return r ? toView(r) : null;
}

export async function getPaginated(
  userId: string,
  page: number,
  limit: number,
): Promise<{ data: Record<string, unknown>[]; page: number; total: number; pages: number }> {
  const uid = new Types.ObjectId(userId);
  const [total, reports] = await Promise.all([
    Report.countDocuments({ userId: uid }),
    Report.find({ userId: uid })
      .sort({ weekStart: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
  ]);

  return {
    data: reports.map(toView),
    page,
    total,
    pages: Math.max(1, Math.ceil(total / limit)),
  };
}
