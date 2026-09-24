/**
 * Summary bar: one panel per provider with the bottleneck window summed across
 * credentials ("160% of 300%"), a segmented meter with one segment per
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
        const [headline, ...rest] = summary.windows;
        const iconSrc = getAuthFileIcon(summary.type, resolvedTheme);
        const typeLabel = getTypeLabel(t, summary.type);
        const restrictions = Object.entries(restrictionCounts[summary.type] ?? {});
        const reset = headline?.nextResetMs
          ? buildResetDisplay(null, headline.nextResetMs, nowMs, i18n.resolvedLanguage)
          : null;

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

            {headline && headline.capacity > 0 ? (
              <>
                <div className={styles.windowLabel}>{windowLabel(t, headline)}</div>
                <div className={styles.total}>
                  <span className={styles.totalValue}>{Math.round(headline.totalRemaining)}%</span>
                  <span className={styles.totalCapacity}>
                    {t('quota_management.summary_of_capacity', { capacity: headline.capacity })}
                  </span>
                </div>
                <div className={styles.segments} aria-hidden="true">
                  {headline.accounts.map((account, index) => (
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
              </>
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
                    <li key={window.id} className={styles.secondaryRow}>
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
