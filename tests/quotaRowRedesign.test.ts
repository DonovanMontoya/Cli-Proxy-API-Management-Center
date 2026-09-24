import { describe, expect, test } from 'bun:test';
import type { TFunction } from 'i18next';
import { maskEmails } from '@/features/quota/privacy';
import { restrictedModelsFor } from '@/features/quota/modelAccess';
import { buildProviderSummaries } from '@/features/quota/summaryModel';
import { buildClaudeQuotaWindows } from '@/features/quota/providers/claude/data';
import { parseCodexUnavailableModels } from '@/features/quota/providers/codex/data';
import type { QuotaFileEntry } from '@/features/quota/logic';
import type { AuthFileItem } from '@/types';

const t = ((key: string) => key) as TFunction;

describe('privacy mode email masking', () => {
  test('keeps the filename prefix, first characters and TLD', () => {
    expect(maskEmails('claude-sam.lee@example.dev.json')).toBe('claude-s•••@e•••.dev.json');
  });

  test('keeps a plan suffix that follows the TLD', () => {
    expect(maskEmails('codex-sam@gmail.com-plus.json')).toBe('codex-s•••@g•••.com-plus.json');
  });

  test('leaves names without an email untouched', () => {
    expect(maskEmails('gemini-project-123.json')).toBe('gemini-project-123.json');
  });

  test('masks every email in a combined label', () => {
    expect(maskEmails('devin.json · a@b.io')).toBe('devin.json · a•••@b•••.io');
  });
});

describe('model access restrictions', () => {
  test('Claude Pro and Free cannot use Fable 5.1; Max can', () => {
    const models = (planType: string) =>
      restrictedModelsFor('claude', { status: 'success', windows: [], planType }).map(
        (restriction) => restriction.model
      );
    expect(models('plan_pro')).toEqual(['Fable 5.1']);
    expect(models('plan_free')).toEqual(['Fable 5.1']);
    expect(models('plan_max')).toEqual([]);
  });

  test('unknown or unloaded state reports nothing rather than guessing', () => {
    expect(restrictedModelsFor('claude', { status: 'success', windows: [] })).toEqual([]);
    expect(restrictedModelsFor('claude', { status: 'loading', planType: 'plan_pro' })).toEqual([]);
  });

  test('Codex restrictions come from the usage payload', () => {
    expect(
      parseCodexUnavailableModels({
        model_usage: {
          'gpt-6-astra': { available: false },
          'gpt-6': { available: true },
          'gpt-6-mini': null,
        },
      })
    ).toEqual(['gpt-6-astra']);
    expect(
      restrictedModelsFor('codex', {
        status: 'success',
        windows: [],
        unavailableModels: ['gpt-6-astra'],
      })
    ).toEqual([{ model: 'gpt-6-astra', source: 'reported' }]);
  });
});

describe('Claude Fable scoped limit matching', () => {
  test('recognises a versioned Fable display name', () => {
    const windows = buildClaudeQuotaWindows(
      {
        limits: [
          {
            kind: 'weekly_scoped',
            percent: 12,
            resets_at: '2026-10-01T00:00:00Z',
            is_active: true,
            scope: { model: { display_name: 'Fable 5.1' } },
          },
        ],
      },
      t
    );
    expect(windows.map((window) => window.id)).toEqual(['seven-day-fable']);
  });

  test('does not treat other models as Fable', () => {
    const windows = buildClaudeQuotaWindows(
      {
        limits: [
          {
            kind: 'weekly_scoped',
            percent: 12,
            scope: { model: { display_name: 'Fableish' } },
          },
        ],
      },
      t
    );
    expect(windows).toEqual([]);
  });
});

describe('provider summary rollup', () => {
  const entry = (name: string, type: QuotaFileEntry['type']): QuotaFileEntry =>
    ({ type, file: { name } as AuthFileItem }) as QuotaFileEntry;
  const now = Date.parse('2026-09-24T12:00:00Z');
  const hour = 3600_000;

  test('sums remaining capacity per window and puts the bottleneck first', () => {
    const entries = [entry('a', 'claude'), entry('b', 'claude'), entry('c', 'codex')];
    const quotas: Record<string, unknown> = {
      a: {
        status: 'success',
        windows: [
          { id: 'five-hour', usedPercent: 0, resetAtMs: now + hour },
          { id: 'seven-day', usedPercent: 60, resetAtMs: now + 48 * hour },
        ],
      },
      b: {
        status: 'success',
        windows: [
          { id: 'five-hour', usedPercent: 50, resetAtMs: now + 2 * hour },
          { id: 'seven-day', usedPercent: 100, resetAtMs: now + 24 * hour },
        ],
      },
      c: { status: 'error', windows: [] },
    };

    const [claude, codex] = buildProviderSummaries(entries, (e) => quotas[e.file.name], now);

    expect(claude.credentialCount).toBe(2);
    expect(claude.loadedCount).toBe(2);
    expect(claude.windows.map((window) => window.id)).toEqual(['seven-day', 'five-hour']);
    expect(claude.windows[0]).toMatchObject({
      totalRemaining: 40,
      capacity: 200,
      nextResetMs: now + 24 * hour,
    });
    expect(claude.windows[0].accounts.map((account) => account.remaining)).toEqual([40, 0]);
    // A full window has nothing to recover, so its reset is not "next".
    expect(claude.windows[1].nextResetMs).toBe(now + 2 * hour);

    expect(codex).toMatchObject({ type: 'codex', credentialCount: 1, loadedCount: 0, windows: [] });
  });
});
