/**
 * Drain rate: how fast quota is being consumed, in percentage points per hour
 * summed across credentials, derived from the recorded usage checkpoints.
 *
 * Pure and clock-injected. Intervals that span a window reset (usage went down)
 * or a long silence between checkpoints are left out rather than guessed, so a
 * stretch with nothing usable shows as a gap.
 */

import { HOUR_MS } from '@/utils/time/durations';
import type { UsageCheckpoint } from './usageHistory';

export interface DrainSample {
  t: number;
  /** Percentage points per hour across all credentials, or null for a gap. */
  rate: number | null;
}

export interface DrainRange {
  id: string;
  hours: number;
}

export const DRAIN_RANGES: readonly DrainRange[] = [
  { id: '6h', hours: 6 },
  { id: '24h', hours: 24 },
  { id: '3d', hours: 72 },
];

export const DEFAULT_DRAIN_RANGE = '24h';

/** Checkpoints further apart than this say nothing about the rate between them. */
export const MAX_CHECKPOINT_GAP_MS = 2 * HOUR_MS;
/** Trailing window each sample averages over. */
export const DRAIN_AVERAGE_MS = HOUR_MS;
/** Share of the averaging window that must have data for a sample to count. */
const MIN_COVERAGE = 0.5;
const SAMPLE_COUNT = 72;

interface Segment {
  start: number;
  end: number;
  /** Percentage points per hour. */
  rate: number;
}

function segmentsOf(points: readonly UsageCheckpoint[]): Segment[] {
  const out: Segment[] = [];
  for (let i = 1; i < points.length; i += 1) {
    const from = points[i - 1];
    const to = points[i];
    const span = to.t - from.t;
    // A drop in usage is a window reset; it carries no drain.
    if (span <= 0 || span > MAX_CHECKPOINT_GAP_MS || to.used < from.used) continue;
    out.push({ start: from.t, end: to.t, rate: (to.used - from.used) / (span / HOUR_MS) });
  }
  return out;
}

/**
 * The latest reading hasn't changed since the last checkpoint (unchanged nearby
 * readings aren't recorded), so usage was flat up to `now`.
 */
export function extendToNow(
  points: readonly UsageCheckpoint[],
  usedNow: number,
  now: number
): UsageCheckpoint[] {
  const last = points[points.length - 1];
  if (last && last.used === usedNow && now > last.t) return [...points, { t: now, used: usedNow }];
  return [...points];
}

/** One credential's average rate over the hour ending at `t`, or null without enough data. */
function averageAt(segments: readonly Segment[], t: number): number | null {
  const from = t - DRAIN_AVERAGE_MS;
  let covered = 0;
  let drained = 0;
  segments.forEach((s) => {
    const overlap = Math.min(s.end, t) - Math.max(s.start, from);
    if (overlap <= 0) return;
    covered += overlap;
    drained += overlap * s.rate;
  });
  return covered >= DRAIN_AVERAGE_MS * MIN_COVERAGE ? drained / covered : null;
}

function sumAt(all: readonly (readonly Segment[])[], t: number): number | null {
  let total: number | null = null;
  all.forEach((segments) => {
    const rate = averageAt(segments, t);
    if (rate !== null) total = (total ?? 0) + rate;
  });
  return total;
}

/** The 1-hour average drain rate at `now`, or null when there isn't enough history. */
export function currentDrainRate(
  series: readonly (readonly UsageCheckpoint[])[],
  now: number
): number | null {
  return sumAt(series.map(segmentsOf), now);
}

/** Evenly spaced samples ending at `now`, covering `rangeMs`. */
export function drainSamples(
  series: readonly (readonly UsageCheckpoint[])[],
  now: number,
  rangeMs: number
): DrainSample[] {
  const segments = series.map(segmentsOf);
  const step = rangeMs / SAMPLE_COUNT;
  return Array.from({ length: SAMPLE_COUNT + 1 }, (_, i) => {
    const t = i === SAMPLE_COUNT ? now : now - rangeMs + i * step;
    return { t, rate: sumAt(segments, t) };
  });
}

/** Y axis with four even intervals on a 1/2/5 step, topping the largest sample. */
export function drainAxis(peak: number): { max: number; ticks: number[] } {
  if (!(peak > 0)) return { max: 4, ticks: [0, 1, 2, 3, 4] };
  const raw = peak / 4;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const mantissa = raw / magnitude;
  const step = (mantissa <= 1 ? 1 : mantissa <= 2 ? 2 : mantissa <= 5 ? 5 : 10) * magnitude;
  const ticks = Array.from({ length: 5 }, (_, i) => Number((step * i).toFixed(6)));
  return { max: ticks[4], ticks };
}

/** One decimal under 10, whole numbers above, so axis labels and stats stay short. */
export const formatDrainRate = (rate: number): string =>
  rate >= 10 ? String(Math.round(rate)) : String(Number(rate.toFixed(1)));

/** Contiguous runs of samples that have data; a null sample breaks the line. */
export function drainRuns(samples: readonly DrainSample[]): { t: number; rate: number }[][] {
  const runs: { t: number; rate: number }[][] = [];
  let current: { t: number; rate: number }[] = [];
  samples.forEach((sample) => {
    if (sample.rate === null) {
      if (current.length) runs.push(current);
      current = [];
    } else {
      current.push({ t: sample.t, rate: sample.rate });
    }
  });
  if (current.length) runs.push(current);
  return runs;
}
