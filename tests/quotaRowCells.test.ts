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

  test('moves the Codex plan and reset count into plain account details', () => {
    const codex: CodexQuotaState = {
      status: 'success',
      planType: 'prolite',
      windows: [{ id: 'weekly', label: 'Weekly limit', usedPercent: 30 }],
      rateLimitResetCreditsAvailableCount: 2,
    };
    expect(rowSubtitleParts('codex', codex, i18n.t, Date.now())).toEqual([
      'Pro 5x',
      'Manual resets 2',
    ]);
    const markup = renderToStaticMarkup(
      createElement(QuotaRowCells, { type: 'codex', quota: codex })
    );
    expect(markup).toContain('Weekly limit');
    expect(markup).not.toContain('Manual resets');
  });
});
