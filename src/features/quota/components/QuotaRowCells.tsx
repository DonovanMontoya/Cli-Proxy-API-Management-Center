/**
 * Row-native rendering for providers whose quota maps cleanly onto columns.
 *
 * The card bodies stack plan badges, renewal dates and reset-credit tables
 * above the meters; squeezed into a row they read as a card inside a row.
 * Here each usage window is one cell, and per-credential facts become a muted
 * subtitle under the name. Providers not listed fall back to their body.
 */

import { useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { ClaudeQuotaState, CodexQuotaState } from '@/types';
import { buildResetDisplay } from '@/utils/quota';
import { useNow } from '@/hooks/useNow';
import { QUOTA_PROGRESS_HIGH_THRESHOLD, QUOTA_PROGRESS_MEDIUM_THRESHOLD } from './QuotaMeter';
import { collectQuotaRowInstants, pickUrgentRowId } from '../resetSchedule';
import { restrictedModelsFor } from '../modelAccess';
import type { QuotaProviderType } from '../providers/types';
import styles from './QuotaRow.module.scss';

const levelClass = (remaining: number | null): string => {
  if (remaining === null) return '';
  if (remaining >= QUOTA_PROGRESS_HIGH_THRESHOLD) return styles.levelHigh;
  if (remaining >= QUOTA_PROGRESS_MEDIUM_THRESHOLD) return styles.levelMedium;
  return styles.levelLow;
};

interface WindowLike {
  id: string;
  label: string;
  labelKey?: string;
  labelParams?: Record<string, string | number>;
  usedPercent: number | null;
  resetLabel?: string;
  resetAtMs?: number | null;
}

function WindowCell({
  window,
  soon,
  nowMs,
  unavailable = false,
}: {
  window: WindowLike;
  soon: boolean;
  nowMs: number;
  unavailable?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const used = window.usedPercent;
  const remaining = used === null ? null : Math.max(0, Math.min(100, 100 - used));
  const label = window.labelKey ? t(window.labelKey, window.labelParams ?? {}) : window.label;
  const reset = buildResetDisplay(
    window.resetLabel,
    window.resetAtMs,
    nowMs,
    i18n.resolvedLanguage
  );

  return (
    <div
      className={unavailable ? `${styles.cell} ${styles.cellUnavailable}` : styles.cell}
      title={
        unavailable
          ? t('quota_management.model_restricted_plan_hint', { model: 'Fable 5.1' })
          : soon
            ? t('quota_management.soonest_row_hint')
            : undefined
      }
      aria-disabled={unavailable || undefined}
    >
      <div className={styles.cellHead}>
        <span className={styles.cellLabel} title={label}>
          {label}
        </span>
        <span className={styles.cellValue}>
          {remaining === null ? '--' : `${Math.round(remaining)}%`}
        </span>
      </div>
      <div className={styles.meter}>
        <div
          className={`${styles.meterFill} ${levelClass(remaining)}`}
          style={{ width: `${remaining ?? 0}%` }}
        />
      </div>
      <div className={styles.cellFoot}>
        {reset ? (
          <>
            {reset.relative && (
              <span
                className={soon ? `${styles.relative} ${styles.relativeSoon}` : styles.relative}
              >
                {reset.relative}
              </span>
            )}
            <span className={styles.absolute}>{reset.absolute}</span>
          </>
        ) : (
          <span className={styles.absolute}>{t('quota_management.summary_no_reset')}</span>
        )}
      </div>
    </div>
  );
}

function StatCell({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className={styles.cell}>
      <div className={styles.cellHead}>
        <span className={styles.cellLabel}>{label}</span>
      </div>
      <div className={styles.statValue}>{value}</div>
    </div>
  );
}

export function QuotaRowCells({ type, quota }: { type: QuotaProviderType; quota: unknown }) {
  const { t } = useTranslation();
  const now = useNow();
  const urgentRowId = useMemo(
    () => pickUrgentRowId(collectQuotaRowInstants(type, quota), now),
    [type, quota, now]
  );

  if (type === 'claude') {
    const claude = quota as ClaudeQuotaState;
    const extra = claude.extraUsage?.is_enabled ? claude.extraUsage : null;
    const fableUnavailable = restrictedModelsFor('claude', quota).some(
      (restriction) => restriction.model === 'Fable 5.1'
    );
    return (
      <>
        {(claude.windows ?? []).map((window) => (
          <WindowCell
            key={window.id}
            window={window}
            soon={window.id === urgentRowId}
            nowMs={now}
            unavailable={fableUnavailable && window.id === 'seven-day-fable'}
          />
        ))}
        {extra && (
          <StatCell
            label={t('claude_quota.extra_usage_label')}
            value={`$${(extra.used_credits / 100).toFixed(2)} / $${(extra.monthly_limit / 100).toFixed(2)}`}
          />
        )}
      </>
    );
  }

  return (
    <>
      {((quota as CodexQuotaState).windows ?? []).map((window) => (
        <WindowCell key={window.id} window={window} soon={window.id === urgentRowId} nowMs={now} />
      ))}
    </>
  );
}
