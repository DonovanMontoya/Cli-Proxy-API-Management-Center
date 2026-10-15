/**
 * Usage forecast card.
 *
 * Two views over every credential at once: the aggregate remaining quota, past
 * and projected with each window's renewal (QuotaRemainingForecast), and the
 * rate it is being consumed (QuotaDrainRate). A per-credential list under the
 * remaining view says which ones are on pace to run out.
 *
 * Checkpoints are recorded here whenever a fresh quota reading arrives, since
 * providers report no history (see usageHistory.ts).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { formatRelativeInstant } from '@/utils/quota';
import { getQuotaCacheKey, getQuotaDisplayName } from '@/utils/quota/identity';
import { useNow } from '@/hooks/useNow';
import { IconChevronDown } from '@/components/ui/icons';
import type { ResolvedTheme } from '@/types';
import {
  buildTimelineLane,
  HOUR_MS,
  type TimelineLane,
  type TimelineMode,
} from '../quotaTimelineModel';
import { currentDrainRate, extendToNow, formatDrainRate } from '../drainRateModel';
import type { RemainingCredential } from '../remainingForecastModel';
import { forecastLane, sortForecasts } from '../usageForecastModel';
import {
  appendCheckpoint,
  historyKey,
  readUsageHistory,
  recentRate,
  writeUsageHistory,
  type UsageHistory,
} from '../usageHistory';
import type { QuotaFileEntry } from '../logic';
import type { QuotaCardState } from '../providers';
import { QuotaDrainRate } from './QuotaDrainRate';
import { QuotaRemainingForecast } from './QuotaRemainingForecast';
import styles from './QuotaUsageForecast.module.scss';

/** The chart accent; matches the orange of the quota meters. */
const ACCENT: Record<ResolvedTheme, string> = { dark: '#e2774f', light: '#c4572c' };

const COLLAPSED_KEY = 'cpamc.quotaForecastCollapsed';
const MODE_PERIODS: Record<TimelineMode, number> = { weekly: 14 * 24, session: 5 };

const pad = (value: number) => String(value).padStart(2, '0');
const formatInstant = (ms: number) => {
  const d = new Date(ms);
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export interface QuotaUsageForecastProps {
  entries: QuotaFileEntry[];
  quotaFor: (entry: QuotaFileEntry) => QuotaCardState | undefined;
  displayNameFor: (name: string) => string;
  resolvedTheme: ResolvedTheme;
  historySessionId: string;
  fileGenerations: Record<string, number>;
  /** Injectable for tests/screenshots; defaults to the real clock. */
  now?: number;
}

export function QuotaUsageForecast({
  entries,
  quotaFor,
  displayNameFor,
  resolvedTheme,
  historySessionId,
  fileGenerations,
  now: nowProp,
}: QuotaUsageForecastProps) {
  const { t, i18n } = useTranslation();
  const [mode, setMode] = useState<TimelineMode>('weekly');
  const [view, setView] = useState<'remaining' | 'drain'>('remaining');
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSED_KEY) === '1';
    } catch {
      return false;
    }
  });
  const toggleCollapsed = () =>
    setCollapsed((value) => {
      try {
        localStorage.setItem(COLLAPSED_KEY, value ? '0' : '1');
      } catch {
        // Not persisted; the toggle still works for this visit.
      }
      return !value;
    });
  const [history, setHistory] = useState<UsageHistory>(() => readUsageHistory(historySessionId));
  const tick = useNow(nowProp === undefined);
  const now = nowProp ?? tick;

  const laneFor = (entry: QuotaFileEntry, maxPeriodHours: number): TimelineLane =>
    buildTimelineLane({
      name: getQuotaCacheKey(entry.file),
      displayName: displayNameFor(getQuotaDisplayName(entry.file)),
      provider: entry.type,
      quota: quotaFor(entry),
      maxPeriodHours,
    });

  /* ---------- Record checkpoints for each fresh reading ---------- */

  // Each fetch stores a new quota object, so identity marks a fresh reading.
  const seenRef = useRef(new WeakSet<object>());
  useEffect(() => {
    let next: UsageHistory | null = null;
    const at = Date.now();
    entries.forEach((entry) => {
      const quota = quotaFor(entry);
      if (!quota || quota.status !== 'success' || seenRef.current.has(quota)) return;
      seenRef.current.add(quota);
      Object.values(MODE_PERIODS).forEach((maxPeriod) => {
        const lane = laneFor(entry, maxPeriod);
        if (lane.anchorMs === null || !lane.periodHours || lane.remaining === null) return;
        const key = historyKey(
          entry.type,
          lane.name,
          lane.periodHours,
          fileGenerations[entry.file.name] ?? 0
        );
        next ??= { ...history };
        next[key] = appendCheckpoint(
          next[key] ?? [],
          { t: at, used: 100 - lane.remaining },
          lane.periodHours * HOUR_MS
        );
      });
    });
    if (next) {
      writeUsageHistory(historySessionId, next);
      setHistory(next);
    }
    // laneFor is derived from quotaFor/displayNameFor, which are listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, quotaFor, displayNameFor, historySessionId, fileGenerations]);

  /* ---------- Credentials ---------- */

  // Every credential on the board, whatever its provider, judged by one window each.
  const credentials = useMemo(() => {
    const out: RemainingCredential[] = [];
    entries.forEach((entry) => {
      const lane = laneFor(entry, MODE_PERIODS[mode]);
      if (mode === 'session' && lane.periodHours !== 5) return;
      if (lane.anchorMs === null || !lane.periodHours) return;
      const periodMs = lane.periodHours * HOUR_MS;
      const recorded =
        history[
          historyKey(entry.type, lane.name, lane.periodHours, fileGenerations[entry.file.name] ?? 0)
        ] ?? [];
      const forecast = forecastLane(
        lane,
        now,
        recentRate(recorded, lane.anchorMs - periodMs, periodMs)
      );
      if (!forecast) return;
      out.push({ forecast, history: extendToNow(recorded, forecast.usedPercent, now) });
    });
    const order = sortForecasts(out.map((c) => c.forecast));
    return order.map((f) => out.find((c) => c.forecast === f) as RemainingCredential);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, quotaFor, displayNameFor, mode, now, history, fileGenerations]);

  const drainSeries = useMemo(() => credentials.map((c) => c.history), [credentials]);
  const drainRate = useMemo(() => currentDrainRate(drainSeries, now), [drainSeries, now]);

  const hasData = credentials.length > 0;
  const atRisk = credentials.filter((c) => c.forecast.runoutAtMs !== null).length;
  const accent = ACCENT[resolvedTheme] ?? ACCENT.dark;
  const remainingTotal = credentials.reduce((sum, c) => sum + 100 - c.forecast.usedPercent, 0);

  if (!hasData && mode === 'weekly') return null;

  return (
    <section className={styles.forecast} data-reveal>
      <header className={styles.head}>
        <div>
          <h2 className={styles.title}>
            <button
              type="button"
              className={styles.collapseToggle}
              aria-expanded={!collapsed}
              onClick={toggleCollapsed}
            >
              <IconChevronDown size={16} className={styles.chevron} aria-hidden="true" />
              {t('quota_management.forecast_title', { defaultValue: 'Usage forecast' })}
            </button>
          </h2>
          <p className={styles.subtitle}>
            {atRisk > 0
              ? t('quota_management.forecast_at_risk', {
                  count: atRisk,
                  defaultValue: '{{count}} credential(s) on pace to run out before reset',
                })
              : t('quota_management.forecast_all_ok', {
                  defaultValue: 'Every credential is on pace to last until its reset',
                })}
          </p>
        </div>
        {!collapsed && (
          <div className={styles.modes} role="group">
            {(['weekly', 'session'] as const).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={mode === value}
                onClick={() => setMode(value)}
              >
                {value === 'weekly'
                  ? t('quota_management.windows_mode_weekly', { defaultValue: 'Weekly' })
                  : t('quota_management.windows_mode_session', { defaultValue: '5-hour' })}
              </button>
            ))}
          </div>
        )}
      </header>

      {!collapsed && (
        <div className={styles.card} style={{ '--series': accent } as CSSProperties}>
          {!hasData ? (
            <div className={styles.empty} role="status">
              {t('quota_management.windows_empty_session', {
                defaultValue: 'No credentials on this page report a 5-hour quota window.',
              })}
            </div>
          ) : (
            <>
              <div className={styles.stat}>
                <span className={styles.statValue}>{Math.round(remainingTotal)}%</span>
                <span className={styles.statTotal}>
                  {t('quota_management.drain_remaining', {
                    defaultValue: '/ {{total}}% remaining',
                    total: credentials.length * 100,
                  })}
                </span>
                {drainRate !== null && (
                  <span className={styles.statRate}>
                    {t('quota_management.drain_rate_now', {
                      defaultValue: '~{{rate}}% per hour',
                      rate: formatDrainRate(drainRate),
                    })}
                  </span>
                )}
              </div>
              <div className={styles.tabs} role="tablist">
                {(['remaining', 'drain'] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    role="tab"
                    aria-selected={view === value}
                    onClick={() => setView(value)}
                  >
                    {value === 'remaining'
                      ? t('quota_management.drain_tab_remaining', {
                          defaultValue: 'Remaining quota',
                        })
                      : t('quota_management.drain_tab_rate', { defaultValue: 'Drain rate' })}
                  </button>
                ))}
              </div>

              {view === 'drain' ? (
                <QuotaDrainRate series={drainSeries} now={now} color={accent} />
              ) : (
                <>
                  <QuotaRemainingForecast credentials={credentials} now={now} color={accent} />
                  <ul className={styles.legend}>
                    {credentials.map(({ forecast }) => {
                      const risk = forecast.runoutAtMs !== null;
                      const target = forecast.runoutAtMs ?? forecast.resetAtMs;
                      return (
                        <li key={forecast.name} data-risk={risk ? 1 : 0}>
                          <span className={styles.swatch} />
                          <span className={styles.name} title={forecast.displayName}>
                            {forecast.displayName}
                          </span>
                          <span className={styles.pct}>
                            {t('quota_management.forecast_left', {
                              defaultValue: '{{now}}% left → {{end}}%',
                              now: Math.round(100 - forecast.usedPercent),
                              end: Math.round(100 - forecast.projectedPercent),
                            })}
                          </span>
                          <span className={styles.eta}>
                            <span className={styles.etaKind}>
                              {risk
                                ? t('quota_management.forecast_runs_out', {
                                    defaultValue: 'Runs out',
                                  })
                                : t('quota_management.forecast_resets', { defaultValue: 'Resets' })}
                            </span>
                            {formatInstant(target)}
                            <span className={styles.etaRelative}>
                              {formatRelativeInstant(target, now, i18n.resolvedLanguage)}
                            </span>
                            {!forecast.fromHistory && (
                              <span
                                className={styles.estimate}
                                title={t('quota_management.forecast_average_hint', {
                                  defaultValue:
                                    'Not enough checkpoints yet; estimated from the whole-window average.',
                                })}
                              >
                                {t('quota_management.forecast_average', { defaultValue: 'avg' })}
                              </span>
                            )}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
