/**
 * Codex usage limits: the reserve and daily pacing the proxy applies before it
 * routes to a Codex credential (CLIProxyAPI sdk/cliproxy/auth/quota_reserve.go).
 *
 * This mirrors the backend math so the panel can draw thresholds and explain
 * them. The backend stays the source of truth for actual pauses, which reach
 * the panel as `usage_limit_paused_until` on the credential entry.
 *
 * React-free so bun:test can consume it directly.
 */

import type { AuthFileFieldsPatch } from '@/services/api/authFiles';
import type { AuthFileItem } from '@/types';
import { DAY_MS, HOUR_MS } from '@/utils/time/durations';

/** Upper bound offered by the editor; the backend itself accepts 0-100. */
export const CODEX_RESERVE_MAX_PERCENT = 50;

/** The backend does not pace windows shorter than two days (the 5h window). */
const MIN_PACED_WINDOW_MS = 2 * DAY_MS;

/**
 * Main windows the proxy reads from the X-Codex-Primary/Secondary headers.
 * Code-review and additional per-feature windows are not limited.
 */
const LIMITED_WINDOW_IDS = new Set(['five-hour', 'weekly', 'monthly']);

/** Window lengths for legacy payloads that omit limit_window_seconds. */
const FALLBACK_WINDOW_HOURS: Record<string, number> = { 'five-hour': 5, weekly: 168 };

export interface CodexUsageLimitDefaults {
  reservePercent: number;
  dailyPacing: boolean;
}

/** Per-credential overrides; null inherits the global default. */
export interface CodexUsageLimitOverrides {
  reservePercent: number | null;
  dailyPacing: boolean | null;
}

export interface CodexUsageLimitPolicy {
  reservePercent: number;
  dailyPacing: boolean;
  /** True when the value comes from the global config rather than the credential. */
  reserveInherited: boolean;
  pacingInherited: boolean;
}

export interface CodexUsageLimitWindow {
  id: string;
  usedPercent: number | null;
  resetAtMs?: number | null;
  periodHours?: number | null;
}

export interface CodexDailyPace {
  /** 1-based day of the window, as the proxy reports it ("day 3 of 7"). */
  day: number;
  days: number;
  /** Highest used% the proxy allows by the end of today. */
  allowedUsedPercent: number;
  /** Allowance each window day adds. */
  dailySharePercent: number;
  usedPercent: number | null;
  /** The proxy pauses the credential until `nextDayAtMs`. */
  reached: boolean;
  /** Start of the next window day (when the allowance grows), capped at the reset. */
  nextDayAtMs: number;
}

/** `percent` is the position from the left of a meter whose fill is the remaining share. */
export type CodexWindowMarker =
  { kind: 'reserve'; percent: number } | { kind: 'pace'; percent: number; pace: CodexDailyPace };

export interface CodexUsageLimitPause {
  untilMs: number;
  reason: string;
}

const clampPercent = (value: number): number => Math.max(0, Math.min(100, value));

export const resolveCodexUsageLimitPolicy = (
  defaults: CodexUsageLimitDefaults,
  overrides: CodexUsageLimitOverrides
): CodexUsageLimitPolicy => ({
  reservePercent: clampPercent(overrides.reservePercent ?? defaults.reservePercent),
  dailyPacing: overrides.dailyPacing ?? defaults.dailyPacing,
  reserveInherited: overrides.reservePercent === null,
  pacingInherited: overrides.dailyPacing === null,
});

export const isCodexUsageLimitActive = (policy: CodexUsageLimitPolicy): boolean =>
  policy.reservePercent > 0 || policy.dailyPacing;

export const isCodexUsageLimitWindow = (windowId: string): boolean =>
  LIMITED_WINDOW_IDS.has(windowId);

/** Length of a limited window long enough to be paced (weekly, monthly), else null. */
const pacedWindowLengthMs = (window: CodexUsageLimitWindow): number | null => {
  if (!isCodexUsageLimitWindow(window.id)) return null;
  const hours = window.periodHours ?? FALLBACK_WINDOW_HOURS[window.id] ?? null;
  if (hours === null || !Number.isFinite(hours)) return null;
  const lengthMs = hours * HOUR_MS;
  return lengthMs >= MIN_PACED_WINDOW_MS ? lengthMs : null;
};

const isCodexPacedWindow = (window: CodexUsageLimitWindow): boolean =>
  pacedWindowLengthMs(window) !== null;

/** Today's allowance for a paced window, or null when pacing does not apply. */
export function computeCodexDailyPace(
  window: CodexUsageLimitWindow,
  policy: CodexUsageLimitPolicy,
  nowMs: number
): CodexDailyPace | null {
  if (!policy.dailyPacing) return null;
  const lengthMs = pacedWindowLengthMs(window);
  const resetAtMs = window.resetAtMs;
  if (lengthMs === null || typeof resetAtMs !== 'number' || !Number.isFinite(resetAtMs)) {
    return null;
  }
  // A window whose reset has passed is stale; the proxy ignores it too.
  if (resetAtMs <= nowMs) return null;
  const startMs = resetAtMs - lengthMs;
  const elapsedMs = nowMs - startMs;
  if (elapsedMs < 0) return null;

  const days = lengthMs / DAY_MS;
  const dayIndex = Math.floor(elapsedMs / DAY_MS);
  const usable = 100 - policy.reservePercent;
  // Unused allowance carries over: the cap grows by one share per day.
  const allowedUsedPercent = usable * Math.min(1, (dayIndex + 1) / days);
  const usedPercent = window.usedPercent;

  return {
    day: dayIndex + 1,
    days: Math.ceil(days),
    allowedUsedPercent,
    dailySharePercent: usable / days,
    usedPercent,
    reached: usedPercent !== null && usedPercent >= allowedUsedPercent,
    nextDayAtMs: Math.min(resetAtMs, startMs + (dayIndex + 1) * DAY_MS),
  };
}

export const isCodexReserveReached = (
  window: CodexUsageLimitWindow,
  policy: CodexUsageLimitPolicy
): boolean =>
  isCodexUsageLimitWindow(window.id) &&
  policy.reservePercent > 0 &&
  window.usedPercent !== null &&
  100 - window.usedPercent <= policy.reservePercent;

/**
 * Threshold ticks for a remaining-% meter: the reserve floor, and for paced
 * windows the remaining share at which today's allowance runs out. The pace
 * tick is dropped when it lands on the reserve (the window's last day).
 */
export function buildCodexWindowMarkers(
  window: CodexUsageLimitWindow,
  policy: CodexUsageLimitPolicy,
  nowMs: number
): CodexWindowMarker[] {
  if (!isCodexUsageLimitWindow(window.id)) return [];
  const markers: CodexWindowMarker[] = [];
  if (policy.reservePercent > 0) {
    markers.push({ kind: 'reserve', percent: policy.reservePercent });
  }
  const pace = computeCodexDailyPace(window, policy, nowMs);
  if (pace) {
    const floor = clampPercent(100 - pace.allowedUsedPercent);
    if (Math.abs(floor - policy.reservePercent) >= 0.5) {
      markers.push({ kind: 'pace', percent: floor, pace });
    }
  }
  return markers;
}

/** The window the editor explains: the first paced main window (normally weekly). */
export const pickCodexPacedWindow = <T extends CodexUsageLimitWindow>(
  windows: readonly T[]
): T | null => windows.find(isCodexPacedWindow) ?? null;

export const readCodexUsageLimitOverrides = (
  file: Pick<AuthFileItem, 'quotaReservePercent' | 'quotaDailyPacing'>
): CodexUsageLimitOverrides => ({
  reservePercent:
    typeof file.quotaReservePercent === 'number' && Number.isFinite(file.quotaReservePercent)
      ? file.quotaReservePercent
      : null,
  dailyPacing: typeof file.quotaDailyPacing === 'boolean' ? file.quotaDailyPacing : null,
});

/** Active usage-limit pause reported by the proxy, or null once it has lifted. */
export const readCodexUsageLimitPause = (
  file: AuthFileItem | undefined,
  nowMs: number
): CodexUsageLimitPause | null => {
  const untilMs = file?.usageLimitPausedUntilMs;
  if (typeof untilMs !== 'number' || !Number.isFinite(untilMs) || untilMs <= nowMs) return null;
  return { untilMs, reason: file?.usageLimitReason ?? '' };
};

/** Only the overrides that changed, or null when there is nothing to save. */
export const buildCodexUsageLimitPatch = (
  current: CodexUsageLimitOverrides,
  next: CodexUsageLimitOverrides
): AuthFileFieldsPatch | null => {
  const patch: AuthFileFieldsPatch = {};
  if (current.reservePercent !== next.reservePercent) {
    patch.quota_reserve_percent = next.reservePercent;
  }
  if (current.dailyPacing !== next.dailyPacing) {
    patch.quota_daily_pacing = next.dailyPacing;
  }
  return Object.keys(patch).length > 0 ? patch : null;
};

/** One decimal, without a trailing ".0" (42.857 → "42.9", 11 → "11"). */
export const formatLimitPercent = (value: number): string => {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
};
