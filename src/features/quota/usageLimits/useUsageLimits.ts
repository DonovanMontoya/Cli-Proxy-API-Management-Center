/**
 * React glue for usage limits: per-provider global defaults from the config
 * store and localized meter markers. The math lives in model.ts.
 */

import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useConfigStore } from '@/stores';
import type { AuthFileItem } from '@/types';
import type { QuotaMeterMarker } from '../components/meterMarkers';
import {
  buildUsageLimitMarkers,
  formatLimitPercent,
  readUsageLimitOverrides,
  resolveUsageLimitPolicy,
  USAGE_LIMIT_DEFAULT_KEYS,
  type UsageLimitDefaults,
  type UsageLimitPolicy,
  type UsageLimitProvider,
  type UsageLimitWindow,
} from './model';

/**
 * quota-exceeded.<provider>-reserve-percent / -daily-pacing from the loaded config.
 * Missing keys mean the backend's zero values.
 */
export function useUsageLimitDefaults(provider: UsageLimitProvider): UsageLimitDefaults {
  const keys = USAGE_LIMIT_DEFAULT_KEYS[provider];
  const reservePercent = useConfigStore(
    (state) => state.config?.quotaExceeded?.[keys.reservePercent]
  );
  const dailyPacing = useConfigStore((state) => state.config?.quotaExceeded?.[keys.dailyPacing]);
  return useMemo(
    () => ({ reservePercent: reservePercent ?? 0, dailyPacing: dailyPacing ?? false }),
    [reservePercent, dailyPacing]
  );
}

/**
 * Effective policy for a credential, or null when the provider has no usage
 * limits or the host has no file to read overrides from.
 */
export function useUsageLimitPolicy(
  provider: UsageLimitProvider | null,
  file?: AuthFileItem
): UsageLimitPolicy | null {
  // Hooks run unconditionally; without a provider the Codex defaults are read but unused.
  const defaults = useUsageLimitDefaults(provider ?? 'codex');
  const hasFile = file !== undefined;
  // Depend on the override fields only: the file object changes on every list refresh.
  const quotaReservePercent = file?.quotaReservePercent;
  const quotaDailyPacing = file?.quotaDailyPacing;
  return useMemo(
    () =>
      provider !== null && hasFile
        ? resolveUsageLimitPolicy(
            provider,
            defaults,
            readUsageLimitOverrides({ quotaReservePercent, quotaDailyPacing })
          )
        : null,
    [defaults, hasFile, provider, quotaReservePercent, quotaDailyPacing]
  );
}

/** Builds the localized reserve / pace ticks for one window meter. */
export function useUsageLimitMarkers(policy: UsageLimitPolicy | null, nowMs: number) {
  const { t } = useTranslation();
  return useCallback(
    (window: UsageLimitWindow): QuotaMeterMarker[] =>
      policy
        ? buildUsageLimitMarkers(window, policy, nowMs).map((marker) => ({
            id: marker.kind,
            percent: marker.percent,
            tone: marker.kind === 'reserve' ? 'critical' : 'neutral',
            label:
              marker.kind === 'reserve'
                ? t('quota_management.usage_limits.marker_reserve', {
                    value: formatLimitPercent(marker.percent),
                  })
                : t('quota_management.usage_limits.marker_pace', {
                    value: formatLimitPercent(marker.percent),
                    day: marker.pace.day,
                    days: marker.pace.days,
                  }),
          }))
        : [],
    [policy, nowMs, t]
  );
}
