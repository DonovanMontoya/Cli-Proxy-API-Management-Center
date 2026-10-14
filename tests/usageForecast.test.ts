import { describe, expect, test } from 'bun:test';
import { forecastLane, sortForecasts } from '@/features/quota/usageForecastModel';
import type { TimelineLane } from '@/features/quota/quotaTimelineModel';
import { appendCheckpoint, recentRate } from '@/features/quota/usageHistory';
import { splitPrimaryWindows } from '@/features/quota/summaryModel';

const HOUR = 3_600_000;
const NOW = 1_800_000_000_000;

const lane = (remaining: number | null, resetInHours: number, periodHours = 168): TimelineLane => ({
  name: `n-${remaining}-${resetInHours}`,
  displayName: 'x',
  provider: 'codex',
  anchorMs: NOW + resetInHours * HOUR,
  periodHours,
  remaining,
  limits: [],
  resetCredits: [],
});

describe('forecastLane', () => {
  test('predicts runout when the pace exceeds the window', () => {
    // 84h elapsed, 60% used → 0.714%/h; 40% left lasts 56h < 84h to reset.
    const f = forecastLane(lane(40, 84), NOW)!;
    expect(f.runoutAtMs).toBe(NOW + 56 * HOUR);
    expect(f.projectedPercent).toBe(100);
  });

  test('no runout when the window resets first', () => {
    // 84h elapsed, 20% used → projected 40% at reset.
    const f = forecastLane(lane(80, 84), NOW)!;
    expect(f.runoutAtMs).toBeNull();
    expect(f.projectedPercent).toBeCloseTo(40);
  });

  test('exhausted windows run out now; stale or unknown windows are skipped', () => {
    expect(forecastLane(lane(0, 10), NOW)!.runoutAtMs).toBe(NOW);
    expect(forecastLane(lane(50, -1), NOW)).toBeNull();
    expect(forecastLane(lane(null, 10), NOW)).toBeNull();
  });

  test('sorts at-risk credentials first by soonest runout', () => {
    const sorted = sortForecasts(
      [lane(80, 84), lane(40, 84), lane(0, 10)].map((l) => forecastLane(l, NOW)!)
    );
    expect(sorted.map((f) => f.usedPercent)).toEqual([100, 60, 20]);
  });
});

describe('usage history', () => {
  const PERIOD = 168 * HOUR;
  test('appendCheckpoint skips unchanged nearby readings and prunes two windows back', () => {
    let points = appendCheckpoint([], { t: NOW, used: 10 }, PERIOD);
    points = appendCheckpoint(points, { t: NOW + 60_000, used: 10 }, PERIOD);
    expect(points).toHaveLength(1);
    points = appendCheckpoint(points, { t: NOW + 3 * PERIOD, used: 5 }, PERIOD);
    expect(points).toEqual([{ t: NOW + 3 * PERIOD, used: 5 }]);
  });

  test('recentRate uses the last quarter-window, not the whole-window average', () => {
    const start = NOW - 100 * HOUR;
    const points = [
      { t: start + HOUR, used: 1 },
      { t: NOW - 40 * HOUR, used: 10 },
      { t: NOW - 20 * HOUR, used: 20 },
      { t: NOW, used: 60 },
    ];
    // Lookback is 42h: from (−40h, 10%) to now → 50% over 40h.
    expect(recentRate(points, start, PERIOD)! * HOUR).toBeCloseTo(1.25);
    expect(recentRate(points.slice(-1), start, PERIOD)).toBeNull();
  });

  test('a recent rate overrides the window average', () => {
    const f = forecastLane(lane(80, 84), NOW, 1 / HOUR)!;
    expect(f.fromHistory).toBe(true);
    expect(f.runoutAtMs).toBe(NOW + 80 * HOUR);
  });
});

describe('summary primary windows', () => {
  const w = (id: string, remaining: number) => ({
    id,
    accounts: [],
    totalRemaining: remaining,
    capacity: 100,
    nextResetMs: null,
  });

  test('stacks session above weekly when both exist, whichever is the bottleneck', () => {
    const { primary, rest } = splitPrimaryWindows([
      w('seven-day-fable', 5),
      w('seven-day', 80),
      w('five-hour', 10),
    ]);
    expect(primary.map((x) => x.id)).toEqual(['five-hour', 'seven-day']);
    expect(rest.map((x) => x.id)).toEqual(['seven-day-fable']);
  });

  test('without a session window the bottleneck leads, as before (Codex today)', () => {
    const { primary, rest } = splitPrimaryWindows([w('code-review-weekly', 20), w('weekly', 50)]);
    expect(primary.map((x) => x.id)).toEqual(['code-review-weekly']);
    expect(rest.map((x) => x.id)).toEqual(['weekly']);
  });

  test('Codex regaining a 5-hour window stacks it above weekly', () => {
    const { primary } = splitPrimaryWindows([w('weekly', 50), w('five-hour', 90)]);
    expect(primary.map((x) => x.id)).toEqual(['five-hour', 'weekly']);
  });
});
