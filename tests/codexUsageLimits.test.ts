import { describe, expect, test } from 'bun:test';
import {
  buildCodexUsageLimitPatch,
  buildCodexWindowMarkers,
  computeCodexDailyPace,
  formatLimitPercent,
  isCodexReserveReached,
  pickCodexPacedWindow,
  readCodexUsageLimitOverrides,
  readCodexUsageLimitPause,
  resolveCodexUsageLimitPolicy,
  type CodexUsageLimitPolicy,
  type CodexUsageLimitWindow,
} from '@/features/quota/providers/codex/usageLimits';
import { normalizeAuthFilesResponse } from '@/services/api/authFiles';
import type { AuthFilesResponse } from '@/types/authFile';
import { DAY_MS, HOUR_MS } from '@/utils/time/durations';

const NOW = Date.UTC(2026, 9, 16, 12, 0, 0);

const policy = (reservePercent: number, dailyPacing: boolean): CodexUsageLimitPolicy =>
  resolveCodexUsageLimitPolicy(
    { reservePercent, dailyPacing },
    {
      reservePercent: null,
      dailyPacing: null,
    }
  );

/** A weekly window that started `elapsedMs` before NOW. */
const weekly = (usedPercent: number | null, elapsedMs: number): CodexUsageLimitWindow => ({
  id: 'weekly',
  usedPercent,
  periodHours: 168,
  resetAtMs: NOW - elapsedMs + 7 * DAY_MS,
});

describe('daily pacing allowance', () => {
  test('grows by one seventh of the usable share per window day', () => {
    const paced = policy(0, true);
    const expected = [1, 2, 3, 4, 5, 6, 7].map((day) => (100 * day) / 7);
    const allowed = [0, 1, 2, 3, 4, 5, 6].map(
      (dayIndex) =>
        computeCodexDailyPace(weekly(0, dayIndex * DAY_MS + HOUR_MS), paced, NOW)
          ?.allowedUsedPercent
    );
    allowed.forEach((value, index) => expect(value).toBeCloseTo(expected[index], 6));
  });

  test('reports the 1-based day, the next day boundary, and whether the cap is reached', () => {
    const pace = computeCodexDailyPace(weekly(43, 2 * DAY_MS + 5 * HOUR_MS), policy(0, true), NOW);
    expect(pace).not.toBeNull();
    expect(pace?.day).toBe(3);
    expect(pace?.days).toBe(7);
    expect(pace?.allowedUsedPercent).toBeCloseTo(42.857, 3);
    expect(pace?.reached).toBe(true);
    // Day 3 ends 19h from now.
    expect(pace?.nextDayAtMs).toBe(NOW + 19 * HOUR_MS);
    expect(formatLimitPercent(pace?.allowedUsedPercent ?? 0)).toBe('42.9');
  });

  test('a reserve shrinks the usable share that is spread over the days', () => {
    const pace = computeCodexDailyPace(weekly(30, 2 * DAY_MS), policy(16, true), NOW);
    // (100 - 16) * 3/7
    expect(pace?.allowedUsedPercent).toBeCloseTo(36, 6);
    expect(pace?.dailySharePercent).toBeCloseTo(12, 6);
    expect(pace?.reached).toBe(false);
  });

  test('unused allowance carries over to later days', () => {
    // Nothing used for four days: day 5 allows five shares at once.
    const idle = computeCodexDailyPace(weekly(60, 4 * DAY_MS + HOUR_MS), policy(0, true), NOW);
    expect(idle?.allowedUsedPercent).toBeCloseTo((100 * 5) / 7, 6);
    expect(idle?.reached).toBe(false);
  });

  test('the last day caps at the usable share and resumes at the reset', () => {
    const window = weekly(88, 6 * DAY_MS + 20 * HOUR_MS);
    const pace = computeCodexDailyPace(window, policy(12, true), NOW);
    expect(pace?.day).toBe(7);
    expect(pace?.allowedUsedPercent).toBeCloseTo(88, 6);
    expect(pace?.reached).toBe(true);
    expect(pace?.nextDayAtMs).toBe(window.resetAtMs ?? 0);
  });

  test('the 5-hour window is never paced', () => {
    const fiveHour: CodexUsageLimitWindow = {
      id: 'five-hour',
      usedPercent: 90,
      periodHours: 5,
      resetAtMs: NOW + HOUR_MS,
    };
    expect(computeCodexDailyPace(fiveHour, policy(0, true), NOW)).toBeNull();
    expect(buildCodexWindowMarkers(fiveHour, policy(0, true), NOW)).toEqual([]);
    expect(pickCodexPacedWindow([fiveHour])).toBeNull();
  });

  test('skips pacing when disabled, stale, or missing a reset time', () => {
    expect(computeCodexDailyPace(weekly(10, DAY_MS), policy(0, false), NOW)).toBeNull();
    const stale = { ...weekly(10, DAY_MS), resetAtMs: NOW - HOUR_MS };
    expect(computeCodexDailyPace(stale, policy(0, true), NOW)).toBeNull();
    const unknown = { ...weekly(10, DAY_MS), resetAtMs: null };
    expect(computeCodexDailyPace(unknown, policy(0, true), NOW)).toBeNull();
  });

  test('legacy weekly windows without a period still pace as seven days', () => {
    const legacy = { ...weekly(10, DAY_MS), periodHours: null };
    expect(computeCodexDailyPace(legacy, policy(0, true), NOW)?.days).toBe(7);
  });

  test('only main windows are limited', () => {
    const codeReview = { ...weekly(99, DAY_MS), id: 'code-review-weekly' };
    expect(computeCodexDailyPace(codeReview, policy(10, true), NOW)).toBeNull();
    expect(isCodexReserveReached(codeReview, policy(10, true))).toBe(false);
    expect(buildCodexWindowMarkers(codeReview, policy(10, true), NOW)).toEqual([]);
  });
});

describe('reserve', () => {
  test('trips once the remaining share drops to the reserve', () => {
    expect(isCodexReserveReached(weekly(88, DAY_MS), policy(12, false))).toBe(true);
    expect(isCodexReserveReached(weekly(87.5, DAY_MS), policy(12, false))).toBe(false);
    expect(isCodexReserveReached(weekly(100, DAY_MS), policy(0, false))).toBe(false);
  });
});

describe('meter markers', () => {
  test('places the reserve and today’s pace floor on a remaining-% meter', () => {
    const markers = buildCodexWindowMarkers(weekly(20, 2 * DAY_MS), policy(16, true), NOW);
    expect(markers.map((marker) => marker.kind)).toEqual(['reserve', 'pace']);
    expect(markers[0].percent).toBe(16);
    // Remaining floor = 100 - (84 * 3/7) = 64.
    expect(markers[1].percent).toBeCloseTo(64, 6);
    expect(markers[1].pace?.day).toBe(3);
  });

  test('drops the pace tick when it lands on the reserve', () => {
    const markers = buildCodexWindowMarkers(weekly(20, 6 * DAY_MS), policy(16, true), NOW);
    expect(markers.map((marker) => marker.kind)).toEqual(['reserve']);
  });

  test('draws nothing without limits', () => {
    expect(buildCodexWindowMarkers(weekly(20, DAY_MS), policy(0, false), NOW)).toEqual([]);
  });
});

describe('policy resolution', () => {
  test('null overrides inherit the global defaults', () => {
    const resolved = resolveCodexUsageLimitPolicy(
      { reservePercent: 11, dailyPacing: true },
      { reservePercent: null, dailyPacing: null }
    );
    expect(resolved).toEqual({
      reservePercent: 11,
      dailyPacing: true,
      reserveInherited: true,
      pacingInherited: true,
    });
  });

  test('explicit overrides win, including zero and false', () => {
    const resolved = resolveCodexUsageLimitPolicy(
      { reservePercent: 11, dailyPacing: true },
      { reservePercent: 0, dailyPacing: false }
    );
    expect(resolved).toEqual({
      reservePercent: 0,
      dailyPacing: false,
      reserveInherited: false,
      pacingInherited: false,
    });
  });

  test('clamps out-of-range reserves like the backend', () => {
    const resolved = resolveCodexUsageLimitPolicy(
      { reservePercent: 0, dailyPacing: false },
      { reservePercent: 140, dailyPacing: null }
    );
    expect(resolved.reservePercent).toBe(100);
  });

  test('reads overrides from a credential and leaves missing ones inherited', () => {
    expect(readCodexUsageLimitOverrides({ quotaReservePercent: 8 })).toEqual({
      reservePercent: 8,
      dailyPacing: null,
    });
    expect(readCodexUsageLimitOverrides({})).toEqual({ reservePercent: null, dailyPacing: null });
  });
});

describe('patch building', () => {
  test('sends only changed fields, with null to inherit', () => {
    expect(
      buildCodexUsageLimitPatch(
        { reservePercent: 10, dailyPacing: true },
        { reservePercent: null, dailyPacing: true }
      )
    ).toEqual({ quota_reserve_percent: null });
    expect(
      buildCodexUsageLimitPatch(
        { reservePercent: null, dailyPacing: null },
        { reservePercent: 12, dailyPacing: false }
      )
    ).toEqual({ quota_reserve_percent: 12, quota_daily_pacing: false });
  });

  test('returns null when nothing changed', () => {
    const same = { reservePercent: 5, dailyPacing: null };
    expect(buildCodexUsageLimitPatch(same, { ...same })).toBeNull();
  });
});

describe('auth-file usage-limit fields', () => {
  const normalize = (files: Array<Record<string, unknown>>) =>
    normalizeAuthFilesResponse({ files } as unknown as AuthFilesResponse).files;

  test('normalizes overrides and the active pause', () => {
    const until = new Date(NOW + 3 * HOUR_MS).toISOString();
    const [file] = normalize([
      {
        name: 'codex-a.json',
        quota_reserve_percent: 11,
        quota_daily_pacing: true,
        usage_limit_paused_until: until,
        usage_limit_reason: 'daily pace reached',
      },
    ]);
    expect(file.quotaReservePercent).toBe(11);
    expect(file.quotaDailyPacing).toBe(true);
    expect(file.usageLimitPausedUntilMs).toBe(NOW + 3 * HOUR_MS);
    expect(readCodexUsageLimitPause(file, NOW)).toEqual({
      untilMs: NOW + 3 * HOUR_MS,
      reason: 'daily pace reached',
    });
    // A pause in the past has lifted even if the list is stale.
    expect(readCodexUsageLimitPause(file, NOW + 4 * HOUR_MS)).toBeNull();
  });

  test('omits absent or malformed fields', () => {
    const [file] = normalize([
      { name: 'codex-b.json', quota_reserve_percent: 'abc', usage_limit_paused_until: '' },
    ]);
    expect(file.quotaReservePercent).toBeUndefined();
    expect(file.quotaDailyPacing).toBeUndefined();
    expect(file.usageLimitPausedUntilMs).toBeUndefined();
    expect(readCodexUsageLimitPause(file, NOW)).toBeNull();
  });
});
