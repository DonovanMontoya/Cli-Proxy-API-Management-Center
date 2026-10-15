/**
 * Aggregate remaining quota across every credential, past and projected.
 *
 * Each credential contributes 100 points, so the total runs from 0 to
 * `100 × credentials`. The past comes from the recorded checkpoints. The future
 * runs each credential down at its current pace until its window resets, where
 * it jumps back to full and starts draining again, repeating every period. The
 * sum of those is the sawtooth: renewals show up as upward steps.
 *
 * Pure and clock-injected.
 */

import { HOUR_MS } from '@/utils/time/durations';
import type { UsageForecast } from './usageForecastModel';
import type { UsageCheckpoint } from './usageHistory';

export interface RemainingCredential {
  forecast: UsageForecast;
  /** Recorded checkpoints, carried up to now (see `extendToNow`). */
  history: readonly UsageCheckpoint[];
}

export interface RemainingPoint {
  t: number;
  /** Percentage points remaining, summed over credentials. */
  remaining: number;
}

export interface RemainingForecast {
  /** Recorded stretch ending at now; empty when no checkpoint covers every credential. */
  past: RemainingPoint[];
  /** Projection starting at now. */
  future: RemainingPoint[];
  /** What a fully refreshed fleet would read: 100 per credential. */
  capacity: number;
}

export interface ForecastRange {
  id: string;
  hours: number;
}

export const FORECAST_RANGES: readonly ForecastRange[] = [
  { id: '24h', hours: 24 },
  { id: '3d', hours: 72 },
  { id: '7d', hours: 168 },
  { id: '14d', hours: 336 },
];

export const DEFAULT_FORECAST_RANGE = '7d';

const MIN_PAST_MS = 6 * HOUR_MS;
const MAX_PAST_MS = 24 * HOUR_MS;
const PAST_SHARE = 0.15;
const GRID_POINTS = 240;
/** Guard against a bad period payload producing an enormous reset list. */
const MAX_RESETS = 2000;

/** Recorded history shown before now: a slice of the horizon, within 6 to 24 hours. */
export const pastSpanMs = (futureMs: number): number =>
  Math.min(MAX_PAST_MS, Math.max(MIN_PAST_MS, futureMs * PAST_SHARE));

/** Percent used at `t` from recorded checkpoints, or null before the first one. */
function usedRecorded(history: readonly UsageCheckpoint[], t: number): number | null {
  if (history.length === 0 || t < history[0].t) return null;
  const next = history.findIndex((p) => p.t >= t);
  if (next === -1) return history[history.length - 1].used;
  if (history[next].t === t) return history[next].used;
  const a = history[next - 1];
  const b = history[next];
  // A drop is a reset: hold the old level until the reading that shows it.
  if (b.used < a.used) return a.used;
  return a.used + ((b.used - a.used) * (t - a.t)) / (b.t - a.t);
}

/** Projected percent used at `t > now`: drain to the reset, then repeat each window. */
function usedProjected(f: UsageForecast, t: number, now: number): number {
  if (t < f.resetAtMs) return Math.min(100, f.usedPercent + f.ratePerMs * (t - now));
  const periodMs = f.periodHours * HOUR_MS;
  return Math.min(100, f.ratePerMs * ((t - f.resetAtMs) % periodMs));
}

/** Instants where a credential's projection jumps or bends, so lines drawn through them stay sharp. */
function breakpoints(f: UsageForecast, now: number, toMs: number): number[] {
  const out: number[] = [];
  if (f.runoutAtMs !== null && f.runoutAtMs > now && f.runoutAtMs < toMs) out.push(f.runoutAtMs);
  const periodMs = f.periodHours * HOUR_MS;
  if (!(periodMs > 0)) return out;
  for (let i = 0, r = f.resetAtMs; r <= toMs && i < MAX_RESETS; i += 1, r += periodMs) {
    if (r > now) out.push(r - 1, r);
  }
  return out;
}

export function forecastRemaining(
  credentials: readonly RemainingCredential[],
  now: number,
  futureMs: number
): RemainingForecast {
  const capacity = credentials.length * 100;
  const fromMs = now - pastSpanMs(futureMs);
  const toMs = now + futureMs;

  const times = new Set<number>([now]);
  for (let i = 0; i <= GRID_POINTS; i += 1) times.add(fromMs + ((toMs - fromMs) * i) / GRID_POINTS);
  credentials.forEach(({ forecast }) =>
    breakpoints(forecast, now, toMs).forEach((t) => times.add(t))
  );
  const ordered = [...times].sort((a, b) => a - b);

  const past: RemainingPoint[] = [];
  const future: RemainingPoint[] = [];
  ordered.forEach((t) => {
    if (t > now) {
      const used = credentials.reduce((sum, c) => sum + usedProjected(c.forecast, t, now), 0);
      future.push({ t, remaining: capacity - used });
      return;
    }
    let used = 0;
    for (const c of credentials) {
      const value = t === now ? c.forecast.usedPercent : usedRecorded(c.history, t);
      if (value === null) return; // not every credential has a reading yet
      used += value;
    }
    past.push({ t, remaining: capacity - used });
  });

  const nowPoint = past[past.length - 1];
  return { past, future: nowPoint ? [nowPoint, ...future] : future, capacity };
}

/** The soonest upcoming renewal and how many points it returns. */
export function nextReset(
  credentials: readonly RemainingCredential[],
  now: number
): { atMs: number; gain: number } | null {
  const [soonest] = credentials
    .map((c) => c.forecast)
    .filter((f) => f.resetAtMs > now)
    .sort((a, b) => a.resetAtMs - b.resetAtMs);
  if (!soonest) return null;
  return {
    atMs: soonest.resetAtMs,
    gain: usedProjected(soonest, soonest.resetAtMs - 1, now),
  };
}

/** Axis labels at quarters of the capacity. */
export const remainingTicks = (capacity: number): number[] =>
  [0, 1, 2, 3, 4].map((i) => (capacity * i) / 4);
