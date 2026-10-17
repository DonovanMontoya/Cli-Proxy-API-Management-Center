/**
 * React glue for Codex usage limits: global defaults from the config store and
 * localized meter markers. The math lives in usageLimits.ts.
 */

import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useConfigStore } from '@/stores';
import type { AuthFileItem } from '@/types';
import type { QuotaMeterMarker } from '../../components/meterMarkers';
import {
  buildCodexWindowMarkers,
  formatLimitPercent,
  readCodexUsageLimitOverrides,
  resolveCodexUsageLimitPolicy,
  type CodexUsageLimitDefaults,
  type CodexUsageLimitPolicy,
  type CodexUsageLimitWindow,
} from './usageLimits';

/** quota-exceeded.codex-* from the loaded config; missing keys mean the backend's zero values. */
export function useCodexUsageLimitDefaults(): CodexUsageLimitDefaults {
  const reservePercent = useConfigStore(
    (state) => state.config?.quotaExceeded?.codexReservePercent
  );
  const dailyPacing = useConfigStore((state) => state.config?.quotaExceeded?.codexDailyPacing);
  return useMemo(
    () => ({ reservePercent: reservePercent ?? 0, dailyPacing: dailyPacing ?? false }),
    [reservePercent, dailyPacing]
  );
}

/** Effective policy for a credential, or null when the host has no file to read overrides from. */
export function useCodexUsageLimitPolicy(file?: AuthFileItem): CodexUsageLimitPolicy | null {
  const defaults = useCodexUsageLimitDefaults();
  const hasFile = file !== undefined;
  // Depend on the override fields only: the file object changes on every list refresh.
  const quotaReservePercent = file?.quotaReservePercent;
  const quotaDailyPacing = file?.quotaDailyPacing;
  return useMemo(
    () =>
      hasFile
        ? resolveCodexUsageLimitPolicy(
            defaults,
            readCodexUsageLimitOverrides({ quotaReservePercent, quotaDailyPacing })
          )
        : null,
    [defaults, hasFile, quotaReservePercent, quotaDailyPacing]
  );
}

/** Builds the localized reserve / pace ticks for one window meter. */
export function useCodexMeterMarkers(policy: CodexUsageLimitPolicy | null, nowMs: number) {
  const { t } = useTranslation();
  return useCallback(
    (window: CodexUsageLimitWindow): QuotaMeterMarker[] =>
      policy
        ? buildCodexWindowMarkers(window, policy, nowMs).map((marker) => ({
            id: marker.kind,
            percent: marker.percent,
            tone: marker.kind === 'reserve' ? 'critical' : 'neutral',
            label:
              marker.kind === 'reserve'
                ? t('codex_quota.limits.marker_reserve', {
                    value: formatLimitPercent(marker.percent),
                  })
                : t('codex_quota.limits.marker_pace', {
                    value: formatLimitPercent(marker.percent),
                    day: marker.pace.day,
                    days: marker.pace.days,
                  }),
          }))
        : [],
    [policy, nowMs, t]
  );
}
