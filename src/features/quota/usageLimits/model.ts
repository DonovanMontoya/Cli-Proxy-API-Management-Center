/**
 * Usage limits: the reserve and daily pacing the proxy applies before it routes
 * to a Codex or Claude credential (CLIProxyAPI sdk/cliproxy/auth/quota_reserve.go).
 * Both providers share the math; they differ in which windows count and in
 * which global defaults apply.
 *
 * This mirrors the backend math so the panel can draw thresholds and explain
 * them. The backend stays the source of truth for actual pauses, which reach
 * the panel as `usage_limit_paused_until` on the credential entry.
 *
 * React-free so bun:test can consume it directly.
 */

import type { AuthFileFieldsPatch } from '@/services/api/authFiles';
import type { AuthFileItem, QuotaExceededConfig } from '@/types';
import { DAY_MS, HOUR_MS } from '@/utils/time/durations';

/** Upper bound offered by the editor; the backend itself accepts 0-100. */
export const USAGE_LIMIT_RESERVE_MAX_PERCENT = 50;

/** The backend does not pace windows shorter than two days (the 5h window). */
const MIN_PACED_WINDOW_MS = 2 * DAY_MS;

export type UsageLimitProvider = 'codex' | 'claude';

/** Config keys holding each provider's global defaults (quota-exceeded.<provider>-*). */
export const USAGE_LIMIT_DEFAULT_KEYS = {
  codex: { reservePercent: 'codexReservePercent', dailyPacing: 'codexDailyPacing' },
  claude: { reservePercent: 'claudeReservePercent', dailyPacing: 'claudeDailyPacing' },
} as const satisfies Record<
  UsageLimitProvider,
  { reservePercent: keyof QuotaExceededConfig; dailyPacing: keyof QuotaExceededConfig }
>;

interface UsageLimitWindowSpec {
  /** Window ids (as built by the provider's data.ts) the proxy limits. */
  limited: ReadonlySet<string>;
  /** Window lengths for payloads that omit the period. */
  fallbackHours: Readonly<Record<string, number>>;
}

const USAGE_LIMIT_WINDOWS: Record<UsageLimitProvider, UsageLimitWindowSpec> = {
  // Main windows the proxy reads from the X-Codex-Primary/Secondary headers.
  // Code-review and additional per-feature windows are not limited.
  codex: {
    limited: new Set(['five-hour', 'weekly', 'monthly']),
    fallbackHours: { 'five-hour': 5, weekly: 168 },
  },
  // Anthropic's `five_hour` session and `seven_day` weekly windows. Model- or
  // product-scoped weekly windows (Opus, Sonnet, OAuth apps, Fable) are not limited.
  claude: {
    limited: new Set(['five-hour', 'seven-day']),
    fallbackHours: { 'five-hour': 5, 'seven-day': 168 },
  },
};

export const usageLimitProviderOf = (type: string): UsageLimitProvider | null =>
  type === 'codex' || type === 'claude' ? type : null;

export interface UsageLimitDefaults {
  reservePercent: number;
  dailyPacing: boolean;
}

/** Per-credential overrides; null inherits the global default. */
export interface UsageLimitOverrides {
  reservePercent: number | null;
  dailyPacing: boolean | null;
}

export interface UsageLimitPolicy {
  provider: UsageLimitProvider;
  reservePercent: number;
  dailyPacing: boolean;
  /** True when the value comes from the global config rather than the credential. */
  reserveInherited: boolean;
  pacingInherited: boolean;
}

export interface UsageLimitWindow {
  id: string;
  usedPercent: number | null;
  resetAtMs?: number | null;
  periodHours?: number | null;
}

export interface DailyPace {
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
export type UsageLimitMarker =
  { kind: 'reserve'; percent: number } | { kind: 'pace'; percent: number; pace: DailyPace };

export interface UsageLimitPause {
  untilMs: number;
  reason: string;
}

export const clampPercent = (value: number): number => Math.max(0, Math.min(100, value));

export const resolveUsageLimitPolicy = (
  provider: UsageLimitProvider,
  defaults: UsageLimitDefaults,
  overrides: UsageLimitOverrides
): UsageLimitPolicy => ({
  provider,
  reservePercent: clampPercent(overrides.reservePercent ?? defaults.reservePercent),
  dailyPacing: overrides.dailyPacing ?? defaults.dailyPacing,
  reserveInherited: overrides.reservePercent === null,
  pacingInherited: overrides.dailyPacing === null,
});

export const isUsageLimitActive = (policy: UsageLimitPolicy): boolean =>
  policy.reservePercent > 0 || policy.dailyPacing;

export const isUsageLimitWindow = (provider: UsageLimitProvider, windowId: string): boolean =>
  USAGE_LIMIT_WINDOWS[provider].limited.has(windowId);

/** Length of a limited window long enough to be paced (weekly, monthly), else null. */
const pacedWindowLengthMs = (
  provider: UsageLimitProvider,
  window: UsageLimitWindow
): number | null => {
  if (!isUsageLimitWindow(provider, window.id)) return null;
  const hours =
    window.periodHours ?? USAGE_LIMIT_WINDOWS[provider].fallbackHours[window.id] ?? null;
  if (hours === null || !Number.isFinite(hours)) return null;
  const lengthMs = hours * HOUR_MS;
  return lengthMs >= MIN_PACED_WINDOW_MS ? lengthMs : null;
};

/** Today's allowance for a paced window, or null when pacing does not apply. */
export function computeDailyPace(
  window: UsageLimitWindow,
  policy: UsageLimitPolicy,
  nowMs: number
): DailyPace | null {
  if (!policy.dailyPacing) return null;
  const lengthMs = pacedWindowLengthMs(policy.provider, window);
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

export const isReserveReached = (window: UsageLimitWindow, policy: UsageLimitPolicy): boolean =>
  isUsageLimitWindow(policy.provider, window.id) &&
  policy.reservePercent > 0 &&
  window.usedPercent !== null &&
  100 - window.usedPercent <= policy.reservePercent;

/**
 * Threshold ticks for a remaining-% meter: the reserve floor, and for paced
 * windows the remaining share at which today's allowance runs out. The pace
 * tick is dropped when it lands on the reserve (the window's last day).
 */
export function buildUsageLimitMarkers(
  window: UsageLimitWindow,
  policy: UsageLimitPolicy,
  nowMs: number
): UsageLimitMarker[] {
  if (!isUsageLimitWindow(policy.provider, window.id)) return [];
  const markers: UsageLimitMarker[] = [];
  if (policy.reservePercent > 0) {
    markers.push({ kind: 'reserve', percent: policy.reservePercent });
  }
  const pace = computeDailyPace(window, policy, nowMs);
  if (pace) {
    const floor = clampPercent(100 - pace.allowedUsedPercent);
    if (Math.abs(floor - policy.reservePercent) >= 0.5) {
      markers.push({ kind: 'pace', percent: floor, pace });
    }
  }
  return markers;
}

/** The window the editor explains: the first paced limited window (normally weekly). */
export const pickPacedWindow = <T extends UsageLimitWindow>(
  provider: UsageLimitProvider,
  windows: readonly T[]
): T | null => windows.find((window) => pacedWindowLengthMs(provider, window) !== null) ?? null;

export const readUsageLimitOverrides = (
  file: Pick<AuthFileItem, 'quotaReservePercent' | 'quotaDailyPacing'>
): UsageLimitOverrides => ({
  reservePercent:
    typeof file.quotaReservePercent === 'number' && Number.isFinite(file.quotaReservePercent)
      ? file.quotaReservePercent
      : null,
  dailyPacing: typeof file.quotaDailyPacing === 'boolean' ? file.quotaDailyPacing : null,
});

/** Active usage-limit pause reported by the proxy, or null once it has lifted. */
export const readUsageLimitPause = (
  file: AuthFileItem | undefined,
  nowMs: number
): UsageLimitPause | null => {
  const untilMs = file?.usageLimitPausedUntilMs;
  if (typeof untilMs !== 'number' || !Number.isFinite(untilMs) || untilMs <= nowMs) return null;
  return { untilMs, reason: file?.usageLimitReason ?? '' };
};

/** Only the overrides that changed, or null when there is nothing to save. */
export const buildUsageLimitPatch = (
  current: UsageLimitOverrides,
  next: UsageLimitOverrides
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
