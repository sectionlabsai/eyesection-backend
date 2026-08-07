/**
 * Day-bucketing helpers shared by the wellness features (comfort entries,
 * engagement streak). Days are computed in the user's IANA timezone so that
 * "today" lines up with the user's local calendar, not the server's UTC clock.
 */

/** Local calendar day key ("YYYY-MM-DD") for an instant in the given timezone. */
export function localDayKey(date: Date, timeZone: string): string {
  // en-CA renders as YYYY-MM-DD, which sorts and compares cleanly.
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
  } catch {
    // Bad/unknown timezone — fall back to UTC so we never throw on a scan write.
    return date.toISOString().slice(0, 10);
  }
}

/**
 * The UTC Date at the start of the user's local day — the stable bucket we
 * persist on ComfortEntry so "one entry per user per day" holds per timezone.
 */
export function localDayStart(date: Date, timeZone: string): Date {
  return new Date(`${localDayKey(date, timeZone)}T00:00:00.000Z`);
}

/** Local wall-clock time as "HH:mm" for an instant in the given timezone. */
export function localTimeHHMM(date: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(date);
  } catch {
    return date.toISOString().slice(11, 16);
  }
}

/**
 * Whether "HH:mm" `t` falls inside a [start, end) window that may wrap midnight
 * (e.g. quiet hours 21:00 → 08:00). Zero-padded strings compare correctly.
 */
export function inTimeWindow(t: string, start: string, end: string): boolean {
  if (start === end) return false;
  return start < end ? t >= start && t < end : t >= start || t < end;
}

/** Step a "YYYY-MM-DD" key back by n days (UTC-safe string math). */
export function subDaysKey(key: string, n: number): string {
  const d = new Date(`${key}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}
