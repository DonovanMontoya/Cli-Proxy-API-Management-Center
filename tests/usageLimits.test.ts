import { describe, expect, test } from 'bun:test';
import {
  buildUsageLimitPatch,
  buildUsageLimitMarkers,
  computeDailyPace,
  formatLimitPercent,
  isReserveReached,
  pickPacedWindow,
  readUsageLimitOverrides,
  readUsageLimitPause,
  resolveUsageLimitPolicy,
  type UsageLimitPolicy,
  type UsageLimitProvider,
  type UsageLimitWindow,
  isUsageLimitWindow,
  usageLimitProviderOf,
} from '@/features/quota/usageLimits/model';
import { buildClaudeQuotaWindows } from '@/features/quota/providers/claude/data';
import type { ClaudeUsagePayload } from '@/types';
import type { TFunction } from 'i18next';
import { normalizeAuthFilesResponse } from '@/services/api/authFiles';
import type { AuthFilesResponse } from '@/types/authFile';
import { DAY_MS, HOUR_MS } from '@/utils/time/durations';

const NOW = Date.UTC(2026, 9, 16, 12, 0, 0);

const policy = (
  reservePercent: number,
  dailyPacing: boolean,
  provider: UsageLimitProvider = 'codex'
): UsageLimitPolicy =>
  resolveUsageLimitPolicy(
    provider,
    { reservePercent, dailyPacing },
    { reservePercent: null, dailyPacing: null }
  );

/** A weekly window that started `elapsedMs` before NOW. */
const weekly = (usedPercent: number | null, elapsedMs: number): UsageLimitWindow => ({
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
        computeDailyPace(weekly(0, dayIndex * DAY_MS + HOUR_MS), paced, NOW)?.allowedUsedPercent
    );
    allowed.forEach((value, index) => expect(value).toBeCloseTo(expected[index], 6));
  });

  test('reports the 1-based day, the next day boundary, and whether the cap is reached', () => {
    const pace = computeDailyPace(weekly(43, 2 * DAY_MS + 5 * HOUR_MS), policy(0, true), NOW);
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
    const pace = computeDailyPace(weekly(30, 2 * DAY_MS), policy(16, true), NOW);
    // (100 - 16) * 3/7
    expect(pace?.allowedUsedPercent).toBeCloseTo(36, 6);
    expect(pace?.dailySharePercent).toBeCloseTo(12, 6);
    expect(pace?.reached).toBe(false);
  });

  test('unused allowance carries over to later days', () => {
    // Nothing used for four days: day 5 allows five shares at once.
    const idle = computeDailyPace(weekly(60, 4 * DAY_MS + HOUR_MS), policy(0, true), NOW);
    expect(idle?.allowedUsedPercent).toBeCloseTo((100 * 5) / 7, 6);
    expect(idle?.reached).toBe(false);
  });

  test('the last day caps at the usable share and resumes at the reset', () => {
    const window = weekly(88, 6 * DAY_MS + 20 * HOUR_MS);
    const pace = computeDailyPace(window, policy(12, true), NOW);
    expect(pace?.day).toBe(7);
    expect(pace?.allowedUsedPercent).toBeCloseTo(88, 6);
    expect(pace?.reached).toBe(true);
    expect(pace?.nextDayAtMs).toBe(window.resetAtMs ?? 0);
  });

  test('the 5-hour window is never paced', () => {
    const fiveHour: UsageLimitWindow = {
      id: 'five-hour',
      usedPercent: 90,
      periodHours: 5,
      resetAtMs: NOW + HOUR_MS,
    };
    expect(computeDailyPace(fiveHour, policy(0, true), NOW)).toBeNull();
    expect(buildUsageLimitMarkers(fiveHour, policy(0, true), NOW)).toEqual([]);
    expect(pickPacedWindow('codex', [fiveHour])).toBeNull();
  });

  test('skips pacing when disabled, stale, or missing a reset time', () => {
    expect(computeDailyPace(weekly(10, DAY_MS), policy(0, false), NOW)).toBeNull();
    const stale = { ...weekly(10, DAY_MS), resetAtMs: NOW - HOUR_MS };
    expect(computeDailyPace(stale, policy(0, true), NOW)).toBeNull();
    const unknown = { ...weekly(10, DAY_MS), resetAtMs: null };
    expect(computeDailyPace(unknown, policy(0, true), NOW)).toBeNull();
  });

  test('legacy weekly windows without a period still pace as seven days', () => {
    const legacy = { ...weekly(10, DAY_MS), periodHours: null };
    expect(computeDailyPace(legacy, policy(0, true), NOW)?.days).toBe(7);
  });

  test('only main windows are limited', () => {
    const codeReview = { ...weekly(99, DAY_MS), id: 'code-review-weekly' };
    expect(computeDailyPace(codeReview, policy(10, true), NOW)).toBeNull();
    expect(isReserveReached(codeReview, policy(10, true))).toBe(false);
    expect(buildUsageLimitMarkers(codeReview, policy(10, true), NOW)).toEqual([]);
  });
});

describe('reserve', () => {
  test('trips once the remaining share drops to the reserve', () => {
    expect(isReserveReached(weekly(88, DAY_MS), policy(12, false))).toBe(true);
    expect(isReserveReached(weekly(87.5, DAY_MS), policy(12, false))).toBe(false);
    expect(isReserveReached(weekly(100, DAY_MS), policy(0, false))).toBe(false);
  });
});

describe('meter markers', () => {
  test('places the reserve and today’s pace floor on a remaining-% meter', () => {
    const markers = buildUsageLimitMarkers(weekly(20, 2 * DAY_MS), policy(16, true), NOW);
    expect(markers.map((marker) => marker.kind)).toEqual(['reserve', 'pace']);
    expect(markers[0].percent).toBe(16);
    // Remaining floor = 100 - (84 * 3/7) = 64.
    expect(markers[1].percent).toBeCloseTo(64, 6);
    expect(markers[1].pace?.day).toBe(3);
  });

  test('drops the pace tick when it lands on the reserve', () => {
    const markers = buildUsageLimitMarkers(weekly(20, 6 * DAY_MS), policy(16, true), NOW);
    expect(markers.map((marker) => marker.kind)).toEqual(['reserve']);
  });

  test('draws nothing without limits', () => {
    expect(buildUsageLimitMarkers(weekly(20, DAY_MS), policy(0, false), NOW)).toEqual([]);
  });
});

describe('policy resolution', () => {
  test('null overrides inherit the global defaults', () => {
    const resolved = resolveUsageLimitPolicy(
      'codex',
      { reservePercent: 11, dailyPacing: true },
      { reservePercent: null, dailyPacing: null }
    );
    expect(resolved).toEqual({
      provider: 'codex',
      reservePercent: 11,
      dailyPacing: true,
      reserveInherited: true,
      pacingInherited: true,
    });
  });

  test('explicit overrides win, including zero and false', () => {
    const resolved = resolveUsageLimitPolicy(
      'codex',
      { reservePercent: 11, dailyPacing: true },
      { reservePercent: 0, dailyPacing: false }
    );
    expect(resolved).toEqual({
      provider: 'codex',
      reservePercent: 0,
      dailyPacing: false,
      reserveInherited: false,
      pacingInherited: false,
    });
  });

  test('clamps out-of-range reserves like the backend', () => {
    const resolved = resolveUsageLimitPolicy(
      'codex',
      { reservePercent: 0, dailyPacing: false },
      { reservePercent: 140, dailyPacing: null }
    );
    expect(resolved.reservePercent).toBe(100);
  });

  test('reads overrides from a credential and leaves missing ones inherited', () => {
    expect(readUsageLimitOverrides({ quotaReservePercent: 8 })).toEqual({
      reservePercent: 8,
      dailyPacing: null,
    });
    expect(readUsageLimitOverrides({})).toEqual({ reservePercent: null, dailyPacing: null });
  });
});

describe('patch building', () => {
  test('sends only changed fields, with null to inherit', () => {
    expect(
      buildUsageLimitPatch(
        { reservePercent: 10, dailyPacing: true },
        { reservePercent: null, dailyPacing: true }
      )
    ).toEqual({ quota_reserve_percent: null });
    expect(
      buildUsageLimitPatch(
        { reservePercent: null, dailyPacing: null },
        { reservePercent: 12, dailyPacing: false }
      )
    ).toEqual({ quota_reserve_percent: 12, quota_daily_pacing: false });
  });

  test('returns null when nothing changed', () => {
    const same = { reservePercent: 5, dailyPacing: null };
    expect(buildUsageLimitPatch(same, { ...same })).toBeNull();
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
    expect(readUsageLimitPause(file, NOW)).toEqual({
      untilMs: NOW + 3 * HOUR_MS,
      reason: 'daily pace reached',
    });
    // A pause in the past has lifted even if the list is stale.
    expect(readUsageLimitPause(file, NOW + 4 * HOUR_MS)).toBeNull();
  });

  test('omits absent or malformed fields', () => {
    const [file] = normalize([
      { name: 'codex-b.json', quota_reserve_percent: 'abc', usage_limit_paused_until: '' },
    ]);
    expect(file.quotaReservePercent).toBeUndefined();
    expect(file.quotaDailyPacing).toBeUndefined();
    expect(file.usageLimitPausedUntilMs).toBeUndefined();
    expect(readUsageLimitPause(file, NOW)).toBeNull();
  });
});

describe('Claude windows', () => {
  /** A Claude window as buildClaudeQuotaWindows produces it. */
  const claudeWindow = (
    id: string,
    usedPercent: number,
    periodHours: number,
    elapsedMs: number
  ): UsageLimitWindow => ({
    id,
    usedPercent,
    periodHours,
    resetAtMs: NOW - elapsedMs + periodHours * HOUR_MS,
  });
  const session = claudeWindow('five-hour', 92, 5, HOUR_MS);
  const weeklyClaude = claudeWindow('seven-day', 43, 168, 2 * DAY_MS + 5 * HOUR_MS);

  test('limits only the five_hour session and seven_day weekly windows', () => {
    expect(isUsageLimitWindow('claude', 'five-hour')).toBe(true);
    expect(isUsageLimitWindow('claude', 'seven-day')).toBe(true);
    for (const id of [
      'seven-day-opus',
      'seven-day-sonnet',
      'seven-day-oauth-apps',
      'seven-day-cowork',
      'seven-day-fable',
    ]) {
      expect(isUsageLimitWindow('claude', id)).toBe(false);
    }
    // Ids are per provider: Codex's weekly id is not a Claude window and vice versa.
    expect(isUsageLimitWindow('claude', 'weekly')).toBe(false);
    expect(isUsageLimitWindow('codex', 'seven-day')).toBe(false);
  });

  test('matches the window ids buildClaudeQuotaWindows emits', () => {
    const t = ((key: string) => key) as TFunction;
    const resetsAt = new Date(NOW + DAY_MS).toISOString();
    const windows = buildClaudeQuotaWindows(
      {
        five_hour: { utilization: 10, resets_at: resetsAt },
        seven_day: { utilization: 20, resets_at: resetsAt },
        seven_day_opus: { utilization: 30, resets_at: resetsAt },
      } as ClaudeUsagePayload,
      t
    );
    expect(
      windows.filter((window) => isUsageLimitWindow('claude', window.id)).map((w) => w.id)
    ).toEqual(['five-hour', 'seven-day']);
  });

  test('paces only the weekly window, with the same math as Codex', () => {
    const claude = policy(0, true, 'claude');
    expect(computeDailyPace(session, claude, NOW)).toBeNull();
    const pace = computeDailyPace(weeklyClaude, claude, NOW);
    expect(pace?.day).toBe(3);
    expect(pace?.days).toBe(7);
    expect(pace?.allowedUsedPercent).toBeCloseTo(42.857, 3);
    expect(pace?.reached).toBe(true);
    expect(pickPacedWindow('claude', [session, weeklyClaude])).toBe(weeklyClaude);
  });

  test('the reserve applies to both the session and weekly windows', () => {
    const claude = policy(10, false, 'claude');
    expect(isReserveReached(session, claude)).toBe(true);
    expect(buildUsageLimitMarkers(session, claude, NOW)).toEqual([
      { kind: 'reserve', percent: 10 },
    ]);
    expect(buildUsageLimitMarkers(weeklyClaude, claude, NOW)).toEqual([
      { kind: 'reserve', percent: 10 },
    ]);
    const opus = claudeWindow('seven-day-opus', 95, 168, DAY_MS);
    expect(isReserveReached(opus, claude)).toBe(false);
    expect(buildUsageLimitMarkers(opus, policy(10, true, 'claude'), NOW)).toEqual([]);
  });

  test('policies resolve from each provider’s own defaults', () => {
    const overrides = { reservePercent: null, dailyPacing: null };
    const codex = resolveUsageLimitPolicy(
      'codex',
      { reservePercent: 11, dailyPacing: false },
      overrides
    );
    const claude = resolveUsageLimitPolicy(
      'claude',
      { reservePercent: 5, dailyPacing: true },
      overrides
    );
    expect([codex.reservePercent, codex.dailyPacing]).toEqual([11, false]);
    expect([claude.reservePercent, claude.dailyPacing]).toEqual([5, true]);
    expect(claude.provider).toBe('claude');
  });

  test('maps only Codex and Claude credentials to a provider', () => {
    expect(usageLimitProviderOf('codex')).toBe('codex');
    expect(usageLimitProviderOf('claude')).toBe('claude');
    expect(usageLimitProviderOf('kimi')).toBeNull();
  });
});
