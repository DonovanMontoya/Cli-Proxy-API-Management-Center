import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import '@/i18n';
import { QuotaTimeline } from '@/features/quota/components/QuotaTimeline';
import { QuotaUsageForecast } from '@/features/quota/components/QuotaUsageForecast';
import {
  getUsageHistorySession,
  historyKey,
  writeUsageHistory,
} from '@/features/quota/usageHistory';
import { getQuotaCacheKey, getQuotaDisplayName } from '@/utils/quota/identity';
import { maskPii } from '@/utils/privacy';
import type { QuotaFileEntry } from '@/features/quota/logic';

const originalSession = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
beforeEach(() => {
  const data = new Map<string, string>();
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => data.set(key, value),
    },
  });
});
afterEach(() => {
  if (originalSession) Object.defineProperty(globalThis, 'sessionStorage', originalSession);
  else Reflect.deleteProperty(globalThis, 'sessionStorage');
});

const now = Date.parse('2099-01-04T00:00:00Z');
const entries: QuotaFileEntry[] = ['first@example.test', 'second@example.test'].map((email, i) => ({
  file: { name: 'devin-demo.json', provider: 'devin', email, authIndex: String(i) },
  type: 'devin',
}));
const quotaFor = () => ({
  status: 'success' as const,
  windows: [
    { id: 'weekly', remainingPercent: 40, resetAtMs: now + 4 * 86400000, periodHours: 168 },
  ],
  observedAtMs: now,
  plan: null,
  planStartMs: null,
  planEndMs: null,
});
const render = (displayNameFor: (name: string) => string) =>
  renderToStaticMarkup(
    createElement(QuotaUsageForecast, {
      entries,
      quotaFor,
      displayNameFor,
      resolvedTheme: 'light',
      now,
      historySessionId: getUsageHistorySession(),
      fileGenerations: {},
    })
  );

describe('forecast privacy', () => {
  test('masks composed Devin labels in the list and leaks no identity into the chart', () => {
    writeUsageHistory(
      getUsageHistorySession(),
      Object.fromEntries(
        entries.map((entry) => [
          historyKey('devin', getQuotaCacheKey(entry.file), 168),
          [{ t: now - 2 * 3600000, used: 50 }],
        ])
      )
    );
    const markup = render(maskPii);
    expect(markup).toContain('role="img"');
    // The aggregate chart is anonymous; any SVG title that does appear must be masked.
    const titles = [...markup.matchAll(/<title>([\s\S]*?)<\/title>/g)].map((match) => match[1]);
    expect(titles.every((title) => title.includes('•••'))).toBe(true);
    for (const entry of entries) {
      expect(markup).not.toContain(entry.file.email!);
      expect(markup).toContain(maskPii(getQuotaDisplayName(entry.file)));
    }
  });

  test('retains distinct composed labels when privacy mode is off', () => {
    const markup = render((name) => name);
    for (const entry of entries) expect(markup).toContain(getQuotaDisplayName(entry.file));
  });

  test('still masks ordinary credential filenames', () => {
    const markup = renderToStaticMarkup(
      createElement(QuotaUsageForecast, {
        entries: [
          { file: { name: 'claude-demo@example.test.json', provider: 'claude' }, type: 'claude' },
        ],
        quotaFor: () => ({
          status: 'success',
          windows: [
            { label: 'weekly', usedPercent: 60, resetAtMs: now + 4 * 86400000, periodHours: 168 },
          ],
        }),
        displayNameFor: maskPii,
        resolvedTheme: 'light',
        now,
        historySessionId: getUsageHistorySession(),
        fileGenerations: {},
      })
    );
    expect(markup).not.toContain('demo@example.test');
    expect(markup).toContain('•••');
  });
});

describe('timeline privacy', () => {
  test('masks composed Devin lane labels and tooltips on the same quota page', () => {
    const markup = renderToStaticMarkup(
      createElement(QuotaTimeline, {
        entries,
        quotaFor,
        displayNameFor: maskPii,
        resolvedTheme: 'light',
        now,
      })
    );
    expect(markup).toContain('<section');
    for (const entry of entries) {
      expect(markup).not.toContain(entry.file.email!);
      expect(markup).toContain(maskPii(getQuotaDisplayName(entry.file)));
    }
  });
});
