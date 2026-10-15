/**
 * Usage forecast: projects each credential's current burn rate forward to
 * predict whether its quota runs out before the window resets.
 *
 * Pure, clock-injected, built on the same lanes the timeline draws so both
 * charts agree on which window a credential is judged by.
 */

import { HOUR_MS, type TimelineLane } from './quotaTimelineModel';

export interface UsageForecast {
  name: string;
  displayName: string;
  provider: TimelineLane['provider'];
  /** Percent used so far in the current window, 0..100. */
  usedPercent: number;
  /** Percent used at reset if the rate holds, 0..100 (capped). */
  projectedPercent: number;
  windowStartMs: number;
  resetAtMs: number;
  /** Predicted exhaustion instant, or null when the window resets first. */
  runoutAtMs: number | null;
  periodHours: number;
  /** True when the rate came from recorded checkpoints, not the window average. */
  fromHistory: boolean;
  /** Projection pace in percent per ms (0 when there is no usage to extrapolate). */
  ratePerMs: number;
}

/**
 * Forecast one lane, or null if it lacks a current window with usage data.
 *
 * Rate is `recentRatePerMs` (from recorded checkpoints) when known, otherwise
 * the window average (used ÷ elapsed) — the payloads carry one snapshot, so
 * without checkpoints that is all the data supports.
 */
export function forecastLane(
  lane: TimelineLane,
  now: number,
  recentRatePerMs: number | null = null
): UsageForecast | null {
  const { anchorMs, periodHours, remaining } = lane;
  if (anchorMs === null || !periodHours || remaining === null) return null;
  if (anchorMs <= now) return null; // stale: the reported window already reset

  const windowStartMs = anchorMs - periodHours * HOUR_MS;
  const usedPercent = 100 - remaining;
  const elapsed = now - windowStartMs;

  let runoutAtMs: number | null = null;
  let projectedPercent = usedPercent;
  let ratePerMs = 0;
  if (usedPercent >= 100) {
    runoutAtMs = now;
  } else if (recentRatePerMs !== null || (usedPercent > 0 && elapsed > 0)) {
    ratePerMs = recentRatePerMs ?? usedPercent / elapsed;
    projectedPercent = Math.min(100, usedPercent + ratePerMs * (anchorMs - now));
    if (ratePerMs > 0) {
      const runout = now + remaining / ratePerMs;
      if (runout < anchorMs) runoutAtMs = runout;
    }
  }

  return {
    name: lane.name,
    displayName: lane.displayName,
    provider: lane.provider,
    usedPercent,
    projectedPercent,
    windowStartMs,
    resetAtMs: anchorMs,
    runoutAtMs,
    periodHours,
    fromHistory: recentRatePerMs !== null,
    ratePerMs,
  };
}

/** At-risk credentials first (soonest runout), then by highest projection. */
export function sortForecasts(forecasts: UsageForecast[]): UsageForecast[] {
  return [...forecasts].sort((a, b) => {
    if (a.runoutAtMs !== null && b.runoutAtMs !== null) return a.runoutAtMs - b.runoutAtMs;
    if (a.runoutAtMs !== null) return -1;
    if (b.runoutAtMs !== null) return 1;
    return b.projectedPercent - a.projectedPercent;
  });
}
