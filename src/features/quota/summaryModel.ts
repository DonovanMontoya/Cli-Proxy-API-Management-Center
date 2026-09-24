/**
 * Per-provider rollup for the quota summary bar.
 *
 * For every usage window a provider exposes (5-hour, weekly, Fable, …) the
 * remaining capacity is summed across that provider's loaded credentials:
 * three accounts at 100% / 60% / 0% read as "160% of 300%". The window with
 * the lowest remaining ratio is the bottleneck and is sorted first.
 *
 * Pure and React-free; labels are resolved by the caller.
 */

import type { QuotaFileEntry } from './logic';
import type { QuotaProviderType } from './providers/types';
import { QUOTA_TAB_ORDER } from './constants';

export interface SummaryAccountWindow {
  remaining: number | null;
  resetAtMs: number | null;
}

export interface SummaryWindow {
  id: string;
  label?: string;
  labelKey?: string;
  labelParams?: Record<string, unknown>;
  accounts: SummaryAccountWindow[];
  totalRemaining: number;
  capacity: number;
  /** Soonest upcoming reset among accounts that have consumed part of this window. */
  nextResetMs: number | null;
}

export interface ProviderSummary {
  type: QuotaProviderType;
  credentialCount: number;
  loadedCount: number;
  windows: SummaryWindow[];
}

interface WindowShape {
  id?: string;
  label?: string;
  labelKey?: string;
  labelParams?: Record<string, unknown>;
  usedPercent?: number | null;
  remainingPercent?: number | null;
  resetAtMs?: number | null;
}

const clampPercent = (value: number) => Math.max(0, Math.min(100, value));

const remainingOf = (window: WindowShape): number | null => {
  if (typeof window.remainingPercent === 'number' && Number.isFinite(window.remainingPercent)) {
    return clampPercent(window.remainingPercent);
  }
  if (typeof window.usedPercent === 'number' && Number.isFinite(window.usedPercent)) {
    return clampPercent(100 - window.usedPercent);
  }
  return null;
};

/** Providers whose state carries a flat `windows` array this rollup understands. */
const WINDOWED_PROVIDERS = new Set<QuotaProviderType>(['claude', 'codex', 'devin']);

const windowsOf = (type: QuotaProviderType, quota: unknown): WindowShape[] => {
  const state = quota as { status?: string; windows?: WindowShape[] } | undefined;
  if (!WINDOWED_PROVIDERS.has(type) || state?.status !== 'success') return [];
  return Array.isArray(state.windows) ? state.windows : [];
};

export function buildProviderSummaries(
  entries: readonly QuotaFileEntry[],
  quotaFor: (entry: QuotaFileEntry) => unknown,
  nowMs: number
): ProviderSummary[] {
  const byType = new Map<QuotaProviderType, ProviderSummary>();
  const windowMaps = new Map<QuotaProviderType, Map<string, SummaryWindow>>();

  for (const entry of entries) {
    let summary = byType.get(entry.type);
    if (!summary) {
      summary = { type: entry.type, credentialCount: 0, loadedCount: 0, windows: [] };
      byType.set(entry.type, summary);
      windowMaps.set(entry.type, new Map());
    }
    summary.credentialCount += 1;

    const quota = quotaFor(entry) as { status?: string } | undefined;
    if (quota?.status !== 'success') continue;
    summary.loadedCount += 1;

    const windows = windowMaps.get(entry.type)!;
    windowsOf(entry.type, quota).forEach((window, index) => {
      const id = window.id || `window-${index}`;
      let aggregate = windows.get(id);
      if (!aggregate) {
        aggregate = {
          id,
          label: window.label,
          labelKey: window.labelKey,
          labelParams: window.labelParams,
          accounts: [],
          totalRemaining: 0,
          capacity: 0,
          nextResetMs: null,
        };
        windows.set(id, aggregate);
      }
      const remaining = remainingOf(window);
      const resetAtMs =
        typeof window.resetAtMs === 'number' && Number.isFinite(window.resetAtMs)
          ? window.resetAtMs
          : null;
      aggregate.accounts.push({ remaining, resetAtMs });
      if (remaining !== null) {
        aggregate.totalRemaining += remaining;
        aggregate.capacity += 100;
      }
      if (
        resetAtMs !== null &&
        resetAtMs > nowMs &&
        remaining !== null &&
        remaining < 100 &&
        (aggregate.nextResetMs === null || resetAtMs < aggregate.nextResetMs)
      ) {
        aggregate.nextResetMs = resetAtMs;
      }
    });
  }

  const ratio = (window: SummaryWindow) =>
    window.capacity > 0 ? window.totalRemaining / window.capacity : Number.POSITIVE_INFINITY;

  for (const [type, summary] of byType) {
    summary.windows = [...windowMaps.get(type)!.values()].sort(
      (a, b) => ratio(a) - ratio(b) || a.id.localeCompare(b.id)
    );
  }

  return QUOTA_TAB_ORDER.filter((type) => byType.has(type)).map((type) => byType.get(type)!);
}
