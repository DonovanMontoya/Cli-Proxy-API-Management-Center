import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import '@/i18n';
import { QuotaRemainingForecast } from '@/features/quota/components/QuotaRemainingForecast';
import {
  forecastRemaining,
  nextReset,
  pastSpanMs,
  remainingTicks,
  type RemainingCredential,
} from '@/features/quota/remainingForecastModel';
import type { UsageForecast } from '@/features/quota/usageForecastModel';

const HOUR = 3_600_000;
const NOW = 1_800_000_000_000;

/** A credential `usedPercent` into a window of `periodHours`, resetting in `resetInHours`. */
const credential = (
  usedPercent: number,
  resetInHours: number,
  ratePerHour: number,
  periodHours = 168
): RemainingCredential => {
  const forecast: UsageForecast = {
    name: `c-${usedPercent}-${resetInHours}`,
    displayName: 'x',
    provider: 'codex',
    usedPercent,
    projectedPercent: usedPercent,
    windowStartMs: NOW + resetInHours * HOUR - periodHours * HOUR,
    resetAtMs: NOW + resetInHours * HOUR,
    runoutAtMs: null,
    periodHours,
    fromHistory: true,
    ratePerMs: ratePerHour / HOUR,
  };
  return {
    forecast,
    history: [
      { t: NOW - 2 * HOUR, used: usedPercent - 2 * ratePerHour },
      { t: NOW, used: usedPercent },
    ],
  };
};

const at = (points: { t: number; remaining: number }[], t: number) =>
  points.find((p) => p.t === t)?.remaining;

describe('forecastRemaining', () => {
  test('sums every credential, so capacity is 100 per credential', () => {
    const result = forecastRemaining(
      [credential(40, 100, 1), credential(10, 100, 1)],
      NOW,
      24 * HOUR
    );
    expect(result.capacity).toBe(200);
    expect(at(result.past, NOW)).toBeCloseTo(150);
  });

  test('projects each credential down at its own pace', () => {
    const result = forecastRemaining(
      [credential(40, 100, 1), credential(10, 100, 3)],
      NOW,
      24 * HOUR
    );
    const end = result.future[result.future.length - 1];
    // 2 credentials, 24h on: used 40 + 24 and 10 + 72.
    expect(end.remaining).toBeCloseTo(200 - 64 - 82);
  });

  test('a renewal steps the total back up by what that credential had used', () => {
    const result = forecastRemaining(
      [credential(50, 10, 1), credential(10, 100, 0)],
      NOW,
      24 * HOUR
    );
    const reset = NOW + 10 * HOUR;
    const before = at(result.future, reset - 1)!;
    const after = at(result.future, reset)!;
    // First credential: used 50 + 10 = 60 just before, 0 right after.
    expect(after - before).toBeCloseTo(60, 0);
  });

  test('a renewed window drains again from full', () => {
    const result = forecastRemaining([credential(50, 5, 2, 10)], NOW, 24 * HOUR);
    // Resets at +5h and +15h and +25h; 3 hours after the first reset it has used 6.
    const nearby = result.future.find((p) => Math.abs(p.t - (NOW + 8 * HOUR)) < 0.2 * HOUR)!;
    expect(nearby.remaining).toBeGreaterThan(90);
    expect(nearby.remaining).toBeLessThan(96);
  });

  test('stops at zero rather than going negative, until the next renewal', () => {
    const result = forecastRemaining([credential(90, 100, 5)], NOW, 24 * HOUR);
    expect(result.future.every((p) => p.remaining >= 0)).toBe(true);
    expect(result.future[result.future.length - 1].remaining).toBe(0);
  });

  test('the recorded past ends at now and starts only where every credential has a reading', () => {
    const late: RemainingCredential = {
      ...credential(30, 100, 1),
      history: [
        { t: NOW - 1 * HOUR, used: 29 },
        { t: NOW, used: 30 },
      ],
    };
    const result = forecastRemaining([credential(40, 100, 1), late], NOW, 24 * HOUR);
    expect(result.past[0].t).toBeGreaterThanOrEqual(NOW - HOUR);
    expect(result.past[result.past.length - 1].t).toBe(NOW);
    expect(result.future[0]).toEqual(result.past[result.past.length - 1]);
  });

  test('a recorded reset is a step, not a ramp', () => {
    const c = credential(10, 100, 0);
    c.history = [
      { t: NOW - 3 * HOUR, used: 90 },
      { t: NOW - 1 * HOUR, used: 5 },
      { t: NOW, used: 10 },
    ];
    const result = forecastRemaining([c], NOW, 24 * HOUR);
    // Between the two readings the level holds at 90 used, never dipping through the middle.
    const held = result.past.filter((p) => p.t > NOW - 2 * HOUR && p.t < NOW - 1.01 * HOUR);
    expect(held.length).toBeGreaterThan(0);
    held.forEach((p) => expect(p.remaining).toBeCloseTo(10));
  });
});

describe('nextReset and axis', () => {
  test('reports the soonest renewal and what it returns', () => {
    const next = nextReset([credential(50, 30, 1), credential(20, 6, 2)], NOW)!;
    expect(next.atMs).toBe(NOW + 6 * HOUR);
    expect(next.gain).toBeCloseTo(32);
    expect(nextReset([], NOW)).toBeNull();
  });

  test('ticks run in quarters of the capacity and the past span scales with the horizon', () => {
    expect(remainingTicks(700)).toEqual([0, 175, 350, 525, 700]);
    expect(pastSpanMs(24 * HOUR)).toBe(6 * HOUR);
    expect(pastSpanMs(7 * 24 * HOUR)).toBe(24 * HOUR);
    expect(pastSpanMs(14 * 24 * HOUR)).toBe(24 * HOUR);
  });
});

describe('QuotaRemainingForecast rendering', () => {
  test('draws solid and projected lines, the now marker and the next reset', () => {
    const html = renderToStaticMarkup(
      createElement(QuotaRemainingForecast, {
        credentials: [credential(40, 30, 1), credential(10, 100, 1)],
        now: NOW,
        color: '#e2774f',
      })
    );
    expect(html).toContain('Remaining');
    expect(html).toContain('Projected');
    expect(html).toContain('Now');
    expect(html).toContain('200%');
    expect(html).toContain('Next reset +');
    expect(html).toContain('url(#remaining-fill)');
  });
});
