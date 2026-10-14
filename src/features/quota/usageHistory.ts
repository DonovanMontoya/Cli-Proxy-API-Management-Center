/**
 * Quota usage checkpoints.
 *
 * Providers only report the current reading, so the panel records one
 * checkpoint per fetched reading and keeps them in sessionStorage. That is the
 * only usage history the forecast chart has; it fills in while the panel is
 * used and is per authenticated browser-tab session. Reconnecting starts fresh.
 */

import { getQuotaCacheFileName } from '@/utils/quota/identity';

export interface UsageCheckpoint {
  /** Epoch ms the reading was observed. */
  t: number;
  /** Percent used, 0..100. */
  used: number;
}

export type UsageHistory = Record<string, UsageCheckpoint[]>;

const LEGACY_STORAGE_KEY = 'cpamc.quotaUsageHistory.v1';
const STORAGE_KEY = 'cpamc.quotaUsageHistory.v2';
// getRandomValues also works on the plain-HTTP origins used by LAN-hosted panels.
function createHistorySession(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  // A scope token is not an authentication secret; support environments without Web Crypto.
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}
let activeSession = createHistorySession();
const MAX_POINTS = 400;
/** An unchanged reading this close to the last one adds nothing. */
const SAME_VALUE_GAP_MS = 30 * 60 * 1000;

/** Provider and file generation prevent reuse after same-name credential replacement. */
export const historyKey = (
  provider: string,
  name: string,
  periodHours: number,
  fileGeneration = 0
) => JSON.stringify([provider, name, periodHours, fileGeneration]);

export const getUsageHistorySession = (): string => activeSession;

/** No backend URL, management key or key-derived identifier is persisted. */
export function resetUsageHistorySession(): string {
  activeSession = createHistorySession();
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage may be unavailable; the new scope still rejects old data and writes.
  }
  discardLegacyHistory();
  return activeSession;
}

function discardLegacyHistory(): void {
  try {
    // v1 has no trustworthy backend/account identity, so it cannot be migrated.
    localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    // Never read legacy history, even when deletion is blocked.
  }
}

/**
 * Append a checkpoint, pruning anything older than two windows so the chart
 * can show the previous window's curve without growing without bound.
 */
export function appendCheckpoint(
  points: readonly UsageCheckpoint[],
  point: UsageCheckpoint,
  periodMs: number
): UsageCheckpoint[] {
  const last = points[points.length - 1];
  if (last && point.t <= last.t) return [...points];
  if (last && last.used === point.used && point.t - last.t < SAME_VALUE_GAP_MS) {
    return [...points];
  }
  const cutoff = point.t - 2 * periodMs;
  return [...points.filter((p) => p.t >= cutoff), point].slice(-MAX_POINTS);
}

export function readUsageHistory(session: string): UsageHistory {
  discardLegacyHistory();
  if (session !== activeSession) return {};
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed?.session !== session || !parsed.history || Array.isArray(parsed.history)) return {};
    const history: UsageHistory = {};
    Object.entries(parsed.history).forEach(([key, points]) => {
      if (!Array.isArray(points)) return;
      const valid = points.filter(
        (point): point is UsageCheckpoint =>
          point &&
          typeof point.t === 'number' &&
          Number.isFinite(point.t) &&
          typeof point.used === 'number' &&
          Number.isFinite(point.used) &&
          point.used >= 0 &&
          point.used <= 100
      );
      history[key] = valid.sort((a, b) => a.t - b.t).slice(-MAX_POINTS);
    });
    return history;
  } catch {
    return {};
  }
}

export function writeUsageHistory(session: string, history: UsageHistory): void {
  if (session !== activeSession) return;
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ session, history }));
  } catch {
    // Storage full or unavailable: the chart just keeps less history.
  }
}

export function invalidateUsageHistory(names: string[]): void {
  const history = readUsageHistory(activeSession);
  const invalidated = new Set(names);
  Object.keys(history).forEach((key) => {
    try {
      const [, name] = JSON.parse(key);
      if (typeof name === 'string' && invalidated.has(getQuotaCacheFileName(name))) {
        delete history[key];
      }
    } catch {
      delete history[key];
    }
  });
  writeUsageHistory(activeSession, history);
}

/**
 * Recent burn rate in percent per ms, from checkpoints inside the current
 * window, or null when they don't span enough time to be meaningful.
 *
 * Measured from the oldest checkpoint within the lookback (a quarter of the
 * window), so a heavy morning shows up in the runout estimate instead of being
 * averaged away across the whole week.
 */
export function recentRate(
  points: readonly UsageCheckpoint[],
  windowStartMs: number,
  periodMs: number
): number | null {
  const inWindow = points.filter((p) => p.t >= windowStartMs);
  if (inWindow.length < 2) return null;
  const latest = inWindow[inWindow.length - 1];
  const lookback = periodMs / 4;
  const minSpan = periodMs / 50;
  let refIndex = inWindow.findIndex((p) => latest.t - p.t <= lookback);
  // Only the latest point is inside the lookback: fall back to the one before it.
  if (refIndex === inWindow.length - 1) refIndex -= 1;
  const ref = inWindow[refIndex];
  const span = latest.t - ref.t;
  if (span < minSpan) return null;
  return Math.max(0, (latest.used - ref.used) / span);
}
