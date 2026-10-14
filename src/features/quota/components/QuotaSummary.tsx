/**
 * Summary bar: one panel per provider with the headline window(s) summed across
 * credentials ("160% of 300%") — session above weekly when both exist,
 * otherwise the bottleneck — a segmented meter with one segment per
 * credential, the soonest reset, the remaining windows as compact lines, and
 * how many credentials cannot use a restricted model.
 */

import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { ResolvedTheme } from '@/types';
import { buildResetDisplay } from '@/utils/quota';
import {
  getAuthFileIcon,
  getThemeSurfaceIconBackground,
  getTypeLabel,
  isThemeSurfaceIconProvider,
} from '@/features/authFiles/constants';
import { QUOTA_PROGRESS_HIGH_THRESHOLD, QUOTA_PROGRESS_MEDIUM_THRESHOLD } from './QuotaMeter';
import { splitPrimaryWindows } from '../summaryModel';
import type { ProviderSummary, SummaryWindow } from '../summaryModel';
import styles from './QuotaSummary.module.scss';

export type QuotaSummaryProps = {
  summaries: ProviderSummary[];
  /** Per provider: restricted model → number of credentials that cannot use it. */
  restrictionCounts: Partial<Record<string, Record<string, number>>>;
  resolvedTheme: ResolvedTheme;
  nowMs: number;
};

const windowLabel = (t: TFunction, window: SummaryWindow): string =>
  window.labelKey
    ? t(window.labelKey, (window.labelParams ?? {}) as Record<string, string | number>)
    : window.label || window.id;

const primaryLabel = (t: TFunction, window: SummaryWindow): string =>
  window.id === 'five-hour'
    ? t('quota_management.summary_session', { defaultValue: 'Session' })
    : window.id === 'seven-day' || window.id === 'weekly'
      ? t('quota_management.summary_weekly', { defaultValue: 'Weekly' })
      : windowLabel(t, window);

const levelClass = (remaining: number | null): string => {
  if (remaining === null) return styles.levelUnknown;
  if (remaining >= QUOTA_PROGRESS_HIGH_THRESHOLD) return styles.levelHigh;
  if (remaining >= QUOTA_PROGRESS_MEDIUM_THRESHOLD) return styles.levelMedium;
  return styles.levelLow;
};

export function QuotaSummary({
  summaries,
  restrictionCounts,
  resolvedTheme,
  nowMs,
}: QuotaSummaryProps) {
  const { t, i18n } = useTranslation();
  if (summaries.length === 0) return null;

  return (
    <section className={styles.panel} aria-label={t('quota_management.summary_label')}>
      {summaries.map((summary) => {
        const { primary, rest } = splitPrimaryWindows(summary.windows);
        const iconSrc = getAuthFileIcon(summary.type, resolvedTheme);
        const typeLabel = getTypeLabel(t, summary.type);
        const restrictedFable =
          summary.loadedCount > 0 &&
          (restrictionCounts[summary.type]?.['Fable 5.1'] ?? 0) >= summary.loadedCount;
        const restrictions = Object.entries(restrictionCounts[summary.type] ?? {}).filter(
          ([model]) => !(summary.type === 'claude' && model === 'Fable 5.1')
        );

        return (
          <article key={summary.type} className={styles.provider}>
            <header className={styles.head}>
              <span
                className={styles.iconWrap}
                style={
                  isThemeSurfaceIconProvider(summary.type)
                    ? { background: getThemeSurfaceIconBackground(resolvedTheme) }
                    : undefined
                }
              >
                {iconSrc ? (
                  <img src={iconSrc} alt="" className={styles.icon} />
                ) : (
                  <span className={styles.iconFallback}>{typeLabel.slice(0, 1).toUpperCase()}</span>
                )}
              </span>
              <span className={styles.providerName}>{typeLabel}</span>
              <span className={styles.count}>
                {t('quota_management.meta_credentials', { count: summary.credentialCount })}
              </span>
            </header>

            {primary.length > 1 ? (
              // Session + weekly share the space one headline takes, so this
              // card stays the same height as single-window cards beside it.
              <div className={styles.compactStack}>
                {primary.map((window) => {
                  const reset = window.nextResetMs
                    ? buildResetDisplay(null, window.nextResetMs, nowMs, i18n.resolvedLanguage)
                    : null;
                  return (
                    <div key={window.id} className={styles.compact}>
                      <div className={styles.compactHead}>
                        <span className={styles.compactLabel}>{primaryLabel(t, window)}</span>
                        <span className={styles.compactReset} title={reset?.absolute}>
                          {reset?.relative ?? reset?.absolute ?? ''}
                        </span>
                        <span className={styles.compactValue}>
                          {Math.round(window.totalRemaining)}%
                          <span className={styles.secondaryCapacity}>/{window.capacity}%</span>
                        </span>
                      </div>
                      <div className={styles.segments} aria-hidden="true">
                        {window.accounts.map((account, index) => (
                          <span key={index} className={styles.segment}>
                            <span
                              className={`${styles.segmentFill} ${levelClass(account.remaining)}`}
                              style={{ width: `${account.remaining ?? 0}%` }}
                            />
                          </span>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : primary.length > 0 ? (
              <div className={styles.primaryStack}>
                {primary.map((window) => {
                  const reset = window.nextResetMs
                    ? buildResetDisplay(null, window.nextResetMs, nowMs, i18n.resolvedLanguage)
                    : null;
                  return (
                    <div key={window.id} className={styles.primary}>
                      <div className={styles.windowLabel}>{windowLabel(t, window)}</div>
                      <div className={styles.total}>
                        <span className={styles.totalValue}>
                          {Math.round(window.totalRemaining)}%
                        </span>
                        <span className={styles.totalCapacity}>
                          {t('quota_management.summary_of_capacity', {
                            capacity: window.capacity,
                          })}
                        </span>
                      </div>
                      <div className={styles.segments} aria-hidden="true">
                        {window.accounts.map((account, index) => (
                          <span key={index} className={styles.segment}>
                            <span
                              className={`${styles.segmentFill} ${levelClass(account.remaining)}`}
                              style={{ width: `${account.remaining ?? 0}%` }}
                            />
                          </span>
                        ))}
                      </div>
                      <div className={styles.reset}>
                        {reset ? (
                          <>
                            {reset.relative && (
                              <span className={styles.resetRelative}>{reset.relative}</span>
                            )}
                            <span className={styles.resetAbsolute}>{reset.absolute}</span>
                          </>
                        ) : (
                          <span className={styles.resetAbsolute}>
                            {t('quota_management.summary_no_reset')}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className={styles.placeholder}>
                {summary.loadedCount === 0
                  ? t('quota_management.summary_not_loaded')
                  : t('quota_management.summary_no_windows')}
              </div>
            )}

            {(rest.length > 0 || restrictions.length > 0) && (
              <ul className={styles.secondary}>
                {rest
                  .filter((window) => window.capacity > 0)
                  .map((window) => (
                    <li
                      key={window.id}
                      className={
                        summary.type === 'claude' &&
                        window.id === 'seven-day-fable' &&
                        restrictedFable
                          ? `${styles.secondaryRow} ${styles.secondaryUnavailable}`
                          : styles.secondaryRow
                      }
                    >
                      <span className={styles.secondaryLabel}>{windowLabel(t, window)}</span>
                      <span className={styles.secondaryValue}>
                        {Math.round(window.totalRemaining)}%
                        <span className={styles.secondaryCapacity}>/{window.capacity}%</span>
                      </span>
                    </li>
                  ))}
                {restrictions.map(([model, count]) => (
                  <li key={model} className={`${styles.secondaryRow} ${styles.restrictedRow}`}>
                    <span className={styles.secondaryLabel}>
                      {t('quota_management.model_restricted', { model })}
                    </span>
                    <span className={styles.secondaryValue}>
                      {t('quota_management.summary_restricted_count', {
                        count,
                        total: summary.loadedCount,
                      })}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </article>
        );
      })}
    </section>
  );
}
