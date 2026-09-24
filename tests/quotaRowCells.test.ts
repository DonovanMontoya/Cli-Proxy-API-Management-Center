import { beforeAll, describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '@/i18n';
import { QuotaRowCells } from '@/features/quota/components/QuotaRowCells';
import { rowSubtitleParts } from '@/features/quota/components/rowCellModel';
import type { ClaudeQuotaState, CodexQuotaState } from '@/types';

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

describe('compact quota rows', () => {
  const claude: ClaudeQuotaState = {
    status: 'success',
    planType: 'plan_pro',
    windows: [
      { id: 'five-hour', label: '5-hour limit', usedPercent: 30 },
      { id: 'seven-day-fable', label: '7-day Fable 5.1', usedPercent: 0 },
    ],
  };

  test('keeps restricted Fable visible but marks only that window unavailable', () => {
    const markup = renderToStaticMarkup(
      createElement(QuotaRowCells, { type: 'claude', quota: claude })
    );
    expect(markup).toContain('7-day Fable 5.1');
    expect(markup.match(/aria-disabled="true"/g)).toHaveLength(1);
    expect(markup).not.toContain('No Fable');

    const maxMarkup = renderToStaticMarkup(
      createElement(QuotaRowCells, { type: 'claude', quota: { ...claude, planType: 'plan_max' } })
    );
    expect(maxMarkup).not.toContain('aria-disabled="true"');
  });

  test('shows manual resets beside Codex usage and keeps the plan under the name', () => {
    const expiresAt = new Date(
      Date.now() + 12 * 24 * 60 * 60 * 1000 + 60 * 60 * 1000
    ).toISOString();
    const codex: CodexQuotaState = {
      status: 'success',
      planType: 'prolite',
      windows: [{ id: 'weekly', label: 'Weekly limit', usedPercent: 30 }],
      rateLimitResetCreditsAvailableCount: 2,
      rateLimitResetCredits: [{ id: 'reset-1', status: 'available', grantedAt: '', expiresAt }],
    };
    expect(rowSubtitleParts('codex', codex, i18n.t, Date.now())).toEqual(['Pro 5x']);
    const markup = renderToStaticMarkup(
      createElement(QuotaRowCells, { type: 'codex', quota: codex })
    );
    expect(markup).toContain('Weekly limit');
    expect(markup).toContain('Manual resets');
    expect(markup).toContain('<strong>2</strong> available');
    expect(markup).toContain('<details');
    expect(markup).toContain('<summary');
    expect(markup).toContain('Reset 1');
    expect(markup).toContain('12 days');
  });

  test('explains when the API provides a reset count without expiry dates', () => {
    const codex: CodexQuotaState = {
      status: 'success',
      windows: [],
      rateLimitResetCreditsAvailableCount: 2,
      rateLimitResetCredits: [],
    };
    const markup = renderToStaticMarkup(
      createElement(QuotaRowCells, { type: 'codex', quota: codex })
    );
    expect(markup).toContain('2</strong> available');
    expect(markup).toContain('Expiry dates are unavailable');
  });

  test('does not offer expiry details when no manual resets remain', () => {
    const markup = renderToStaticMarkup(
      createElement(QuotaRowCells, {
        type: 'codex',
        quota: {
          status: 'success',
          windows: [],
          rateLimitResetCreditsAvailableCount: 0,
        } satisfies CodexQuotaState,
      })
    );
    expect(markup).toContain('<strong>0</strong> available');
    expect(markup).not.toContain('<details');
  });
});
