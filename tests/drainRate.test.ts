import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import '@/i18n';
import { QuotaDrainRate } from '@/features/quota/components/QuotaDrainRate';
import {
  currentDrainRate,
  drainAxis,
  drainRuns,
  drainSamples,
  extendToNow,
  formatDrainRate,
} from '@/features/quota/drainRateModel';
import type { UsageCheckpoint } from '@/features/quota/usageHistory';

const HOUR = 3_600_000;
const NOW = 1_800_000_000_000;

/** Checkpoints every 30 minutes ending at NOW, gaining `perHour` points per hour. */
const steady = (perHour: number, hours: number, startUsed = 0): UsageCheckpoint[] =>
  Array.from({ length: hours * 2 + 1 }, (_, i) => ({
    t: NOW - hours * HOUR + (i * HOUR) / 2,
    used: startUsed + (i * perHour) / 2,
  }));

describe('currentDrainRate', () => {
  test('reports the hourly pace of a steady climb', () => {
    expect(currentDrainRate([steady(3, 4)], NOW)).toBeCloseTo(3);
  });

  test('sums credentials', () => {
    expect(currentDrainRate([steady(3, 4), steady(2, 4)], NOW)).toBeCloseTo(5);
  });

  test('a reset (usage going down) is excluded, not counted as negative drain', () => {
    const points: UsageCheckpoint[] = [
      { t: NOW - 1.5 * HOUR, used: 80 },
      { t: NOW - HOUR, used: 90 },
      { t: NOW - 0.5 * HOUR, used: 2 }, // reset
      { t: NOW, used: 4 },
    ];
    // Only the 90 -> 2 interval is dropped; the last half hour gained 2 points.
    expect(currentDrainRate([points], NOW)).toBeCloseTo(4);
  });

  test('a long silence between checkpoints is a gap, not an estimate', () => {
    const points: UsageCheckpoint[] = [
      { t: NOW - 10 * HOUR, used: 10 },
      { t: NOW, used: 50 },
    ];
    expect(currentDrainRate([points], NOW)).toBeNull();
  });

  test('needs half the averaging hour covered', () => {
    const recent: UsageCheckpoint[] = [
      { t: NOW - 0.25 * HOUR, used: 10 },
      { t: NOW, used: 11 },
    ];
    expect(currentDrainRate([recent], NOW)).toBeNull();
    expect(currentDrainRate([], NOW)).toBeNull();
  });
});

describe('extendToNow', () => {
  test('carries an unchanged reading forward as flat usage', () => {
    const points = [{ t: NOW - 0.4 * HOUR, used: 12 }];
    expect(extendToNow(points, 12, NOW)).toEqual([...points, { t: NOW, used: 12 }]);
  });

  test('leaves a changed reading alone', () => {
    const points = [{ t: NOW - 0.4 * HOUR, used: 12 }];
    expect(extendToNow(points, 15, NOW)).toEqual(points);
  });
});

describe('drainSamples and runs', () => {
  test('samples span the range ending at now', () => {
    const samples = drainSamples([steady(2, 30)], NOW, 24 * HOUR);
    expect(samples[0].t).toBe(NOW - 24 * HOUR);
    expect(samples[samples.length - 1].t).toBe(NOW);
    expect(samples.every((s) => s.rate !== null && Math.abs(s.rate - 2) < 1e-6)).toBe(true);
  });

  test('missing history before the first checkpoint leaves a leading gap', () => {
    const samples = drainSamples([steady(2, 6)], NOW, 24 * HOUR);
    expect(samples[0].rate).toBeNull();
    expect(samples[samples.length - 1].rate).toBeCloseTo(2);
    const runs = drainRuns(samples);
    expect(runs).toHaveLength(1);
    expect(runs[0][0].t).toBeGreaterThan(NOW - 24 * HOUR);
  });

  test('a null sample splits the line into separate runs', () => {
    const runs = drainRuns([
      { t: 1, rate: 1 },
      { t: 2, rate: null },
      { t: 3, rate: 2 },
      { t: 4, rate: 3 },
    ]);
    expect(runs.map((r) => r.length)).toEqual([1, 2]);
  });
});

describe('drainAxis', () => {
  test('uses four even intervals on a 1/2/5 step above the peak', () => {
    expect(drainAxis(11)).toEqual({ max: 20, ticks: [0, 5, 10, 15, 20] });
    expect(drainAxis(3.2)).toEqual({ max: 4, ticks: [0, 1, 2, 3, 4] });
    expect(drainAxis(0.4)).toEqual({ max: 0.4, ticks: [0, 0.1, 0.2, 0.3, 0.4] });
  });

  test('has a usable axis when nothing has drained', () => {
    expect(drainAxis(0).max).toBe(4);
  });

  test('formats rates compactly', () => {
    expect(formatDrainRate(2.34)).toBe('2.3');
    expect(formatDrainRate(11.4)).toBe('11');
    expect(formatDrainRate(0)).toBe('0');
  });
});

describe('QuotaDrainRate rendering', () => {
  const render = (series: UsageCheckpoint[][]) =>
    renderToStaticMarkup(createElement(QuotaDrainRate, { series, now: NOW, color: '#e2774f' }));

  test('draws the area, legend and footnote', () => {
    const html = render([steady(4, 30)]);
    expect(html).toContain('% per hour');
    expect(html).toContain('1-hour average');
    expect(html).toContain('Last 24 hours');
    expect(html).toContain('Peak 4 % per hour');
    expect(html).toContain('Resets excluded');
    expect(html).toContain('Gaps mean missing history');
    expect(html).toContain('url(#drain-rate-fill)');
    expect(html).not.toContain('Not enough history');
  });

  test('explains an empty chart instead of drawing nothing', () => {
    const html = render([]);
    expect(html).toContain('Not enough history yet');
    expect(html).not.toContain('url(#drain-rate-fill)');
  });
});
