/**
 * Quota usage checkpoints.
 *
 * Providers only report the current reading, so the panel records one
 * checkpoint per fetched reading and keeps them in localStorage. That is the
 * only usage history the forecast chart has; it fills in while the panel is
 * used and is per browser.
 */

export interface UsageCheckpoint {
  /** Epoch ms the reading was observed. */
  t: number;
  /** Percent used, 0..100. */
  used: number;
}

export type UsageHistory = Record<string, UsageCheckpoint[]>;

const STORAGE_KEY = 'cpamc.quotaUsageHistory.v1';
const MAX_POINTS = 400;
/** An unchanged reading this close to the last one adds nothing. */
const SAME_VALUE_GAP_MS = 30 * 60 * 1000;

/** One series per credential and window length. */
export const historyKey = (name: string, periodHours: number) => `${name}|${periodHours}`;

/**
 * Append a checkpoint, pruning anything older than two windows so the chart
 * can show the previous window's curve without growing without bound.
 */
export function appendCheckpoint(
  points: readonly UsageCheckpoint[],
  point: UsageCheckpoint,
  periodMs: number
): UsageCheckpoint[] {
  const last = points[points.length - 1];
  if (last && point.t <= last.t) return [...points];
  if (last && last.used === point.used && point.t - last.t < SAME_VALUE_GAP_MS) {
    return [...points];
  }
  const cutoff = point.t - 2 * periodMs;
  return [...points.filter((p) => p.t >= cutoff), point].slice(-MAX_POINTS);
}

export function readUsageHistory(): UsageHistory {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? (parsed as UsageHistory) : {};
  } catch {
    return {};
  }
}

export function writeUsageHistory(history: UsageHistory): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
  } catch {
    // Storage full or unavailable: the chart just keeps less history.
  }
}

/**
 * Recent burn rate in percent per ms, from checkpoints inside the current
 * window, or null when they don't span enough time to be meaningful.
 *
 * Measured from the oldest checkpoint within the lookback (a quarter of the
 * window), so a heavy morning shows up in the runout estimate instead of being
 * averaged away across the whole week.
 */
export function recentRate(
  points: readonly UsageCheckpoint[],
  windowStartMs: number,
  periodMs: number
): number | null {
  const inWindow = points.filter((p) => p.t >= windowStartMs);
  if (inWindow.length < 2) return null;
  const latest = inWindow[inWindow.length - 1];
  const lookback = periodMs / 4;
  const minSpan = periodMs / 50;
  let refIndex = inWindow.findIndex((p) => latest.t - p.t <= lookback);
  // Only the latest point is inside the lookback: fall back to the one before it.
  if (refIndex === inWindow.length - 1) refIndex -= 1;
  const ref = inWindow[refIndex];
  const span = latest.t - ref.t;
  if (span < minSpan) return null;
  return Math.max(0, (latest.used - ref.used) / span);
}
