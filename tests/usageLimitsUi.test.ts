import { beforeAll, describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '@/i18n';
import { QuotaRowCells } from '@/features/quota/components/QuotaRowCells';
import { QuotaMeter } from '@/features/quota/components/QuotaMeter';
import { CodexQuotaBody } from '@/features/quota/providers/codex/CodexQuotaBody';
import { ClaudeQuotaBody } from '@/features/quota/providers/claude/ClaudeQuotaBody';
import { QUOTA_CLASS_KEYS, bindQuotaClasses } from '@/features/quota/types';
import type { AuthFileItem, ClaudeQuotaState, CodexQuotaState } from '@/types';
import { DAY_MS, HOUR_MS } from '@/utils/time/durations';

const classes = bindQuotaClasses(
  Object.fromEntries(QUOTA_CLASS_KEYS.map((key) => [key, key])),
  'test-host'
);

// useNow() freezes to module-load time under renderToStaticMarkup, and store
// selectors read the initial state there, so global defaults are 0 / off here
// (inheritance is covered by usageLimits.test.ts).
const now = Date.now();

const quota: CodexQuotaState = {
  status: 'success',
  windows: [
    {
      id: 'five-hour',
      label: '5-hour limit',
      usedPercent: 10,
      resetLabel: '-',
      resetAtMs: now + 2 * HOUR_MS,
      periodHours: 5,
    },
    {
      id: 'weekly',
      label: 'Weekly limit',
      usedPercent: 20,
      resetLabel: '-',
      // Day 3 of 7.
      resetAtMs: now + 4 * DAY_MS + 12 * HOUR_MS,
      periodHours: 168,
    },
    {
      id: 'code-review-weekly',
      label: 'Code review weekly limit',
      usedPercent: 0,
      resetLabel: '-',
      resetAtMs: now + 4 * DAY_MS,
      periodHours: 168,
    },
  ],
};

const markerCount = (markup: string) => markup.match(/role="img"/g)?.length ?? 0;

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

describe('Codex usage-limit meter markers', () => {
  test('row cells draw reserve ticks on main windows and a pace tick on the weekly one', () => {
    const file: AuthFileItem = {
      name: 'codex-a.json',
      quotaReservePercent: 16,
      quotaDailyPacing: true,
    };
    const markup = renderToStaticMarkup(
      createElement(QuotaRowCells, { type: 'codex', quota, file })
    );
    // 5h: reserve; weekly: reserve + pace; code review: none.
    expect(markerCount(markup)).toBe(3);
    expect(markup).toContain('Reserve: routing stops at 16% left');
    expect(markup).toContain('left:16%');
    // 100 - 84 * 3/7 = 64.
    expect(markup).toContain('left:64%');
    expect(markup).toContain('day 3 of 7');
  });

  test('no file or no limits leaves the meters untouched', () => {
    const withoutFile = renderToStaticMarkup(
      createElement(QuotaRowCells, { type: 'codex', quota })
    );
    expect(markerCount(withoutFile)).toBe(0);
    const meter = renderToStaticMarkup(createElement(QuotaMeter, { percent: 40, classes }));
    expect(meter).toBe(
      '<div class="quotaBar"><div class="quotaBarFill quotaBarFillMedium" style="width:40%"></div></div>'
    );
  });
});

describe('Codex usage-limit pause', () => {
  test('the card body shows the pause with its reason', () => {
    const file: AuthFileItem = {
      name: 'codex-c.json',
      quotaReservePercent: 12,
      usageLimitPausedUntilMs: now + 3 * HOUR_MS,
      usageLimitReason: 'usage reserve reached: 12.0% left in the weekly window',
    };
    const markup = renderToStaticMarkup(createElement(CodexQuotaBody, { quota, classes, file }));
    expect(markup).toContain('class="codexUsageLimitPause"');
    expect(markup).toContain('title="usage reserve reached: 12.0% left in the weekly window"');
    expect(markup).toContain('Paused by usage limit until');
    expect(markup).toContain('in 3 hours');
    expect(markerCount(markup)).toBe(2);
  });

  test('a lifted pause is not shown', () => {
    const file: AuthFileItem = {
      name: 'codex-d.json',
      usageLimitPausedUntilMs: now - HOUR_MS,
      usageLimitReason: 'old',
    };
    const markup = renderToStaticMarkup(createElement(CodexQuotaBody, { quota, classes, file }));
    expect(markup).not.toContain('codexUsageLimitPause');
  });
});

describe('Claude usage limits', () => {
  const claudeQuota: ClaudeQuotaState = {
    status: 'success',
    windows: [
      {
        id: 'five-hour',
        label: '5-hour session',
        usedPercent: 30,
        resetLabel: '-',
        resetAtMs: now + 2 * HOUR_MS,
        periodHours: 5,
      },
      {
        id: 'seven-day',
        label: 'Weekly',
        usedPercent: 20,
        resetLabel: '-',
        // Day 3 of 7.
        resetAtMs: now + 4 * DAY_MS + 12 * HOUR_MS,
        periodHours: 168,
      },
      {
        id: 'seven-day-opus',
        label: 'Weekly Opus',
        usedPercent: 50,
        resetLabel: '-',
        resetAtMs: now + 4 * DAY_MS,
        periodHours: 168,
      },
    ],
  };
  const file: AuthFileItem = {
    name: 'claude-a.json',
    quotaReservePercent: 16,
    quotaDailyPacing: true,
    usageLimitPausedUntilMs: now + 2 * HOUR_MS,
    usageLimitReason: 'daily pace reached',
  };

  test('row cells tick the session and weekly windows only', () => {
    const markup = renderToStaticMarkup(
      createElement(QuotaRowCells, { type: 'claude', quota: claudeQuota, file })
    );
    // Session: reserve; weekly: reserve + pace; Opus: none.
    expect(markerCount(markup)).toBe(3);
    expect(markup).toContain('left:64%');
    expect(markup).toContain('day 3 of 7');
  });

  test('the card body shows ticks and the pause line', () => {
    const markup = renderToStaticMarkup(
      createElement(ClaudeQuotaBody, { quota: claudeQuota, classes, file })
    );
    expect(markerCount(markup)).toBe(3);
    expect(markup).toContain('class="codexUsageLimitPause"');
    expect(markup).toContain('title="daily pace reached"');
  });
});
