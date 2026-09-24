/**
 * Row-native rendering for providers whose quota maps cleanly onto columns.
 *
 * The card bodies stack plan badges, renewal dates and reset-credit tables
 * above the meters; squeezed into a row they read as a card inside a row.
 * Here each usage window is one fixed-width cell, per-credential facts (plan,
 * renewal) become a muted subtitle under the name, and manual resets collapse
 * into a single summary cell. Providers not listed fall back to their body.
 */

import { useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { ClaudeQuotaState, CodexQuotaState } from '@/types';
import { buildResetDisplay, parseIsoToMs, resolveResetMs } from '@/utils/quota';
import { formatDateTimeValue } from '@/utils/format';
import { useNow } from '@/hooks/useNow';
import { QUOTA_PROGRESS_HIGH_THRESHOLD, QUOTA_PROGRESS_MEDIUM_THRESHOLD } from './QuotaMeter';
import { collectQuotaRowInstants, pickUrgentRowId, resetCreditRowId } from '../resetSchedule';
import { getCodexPlanLabel } from '../providers/codex/planLabel';
import type { QuotaProviderType } from '../providers/types';
import styles from './QuotaRow.module.scss';

export const hasRowCells = (type: QuotaProviderType): boolean =>
  type === 'claude' || type === 'codex';

/** Muted line under the credential name: plan, then (Codex) renewal. */
export function rowSubtitleParts(
  type: QuotaProviderType,
  quota: unknown,
  t: TFunction,
  nowMs: number,
  locale?: string
): string[] {
  const state = quota as { status?: string } | undefined;
  if (state?.status !== 'success') return [];

  if (type === 'claude') {
    const planType = (quota as ClaudeQuotaState).planType;
    return planType ? [t(`claude_quota.${planType}`)] : [];
  }

  if (type === 'codex') {
    const codex = quota as CodexQuotaState;
    const parts: string[] = [];
    const plan = getCodexPlanLabel(codex.planType, t);
    if (plan) parts.push(plan);
    const until = codex.subscriptionActiveUntil ?? null;
    if (until !== null && until !== '') {
      const untilMs = resolveResetMs([until]);
      const display = buildResetDisplay(
        untilMs === null ? formatDateTimeValue(until) : null,
        untilMs,
        nowMs,
        locale
      );
      if (display) {
        parts.push(t('quota_management.row_renews', { date: display.absolute }));
        if (display.relative) parts.push(display.relative);
      }
    }
    return parts;
  }

  return [];
}

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

function WindowCell({ window, soon, nowMs }: { window: WindowLike; soon: boolean; nowMs: number }) {
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
    <div className={styles.cell} title={soon ? t('quota_management.soonest_row_hint') : undefined}>
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

function StatCell({
  label,
  value,
  foot,
  soon = false,
}: {
  label: string;
  value: ReactNode;
  foot?: { relative?: string | null; text: string } | null;
  soon?: boolean;
}) {
  return (
    <div className={styles.cell}>
      <div className={styles.cellHead}>
        <span className={styles.cellLabel}>{label}</span>
      </div>
      <div className={styles.statValue}>{value}</div>
      {foot && (
        <div className={styles.cellFoot}>
          <span className={styles.absolute}>{foot.text}</span>
          {foot.relative && (
            <span className={soon ? `${styles.relative} ${styles.relativeSoon}` : styles.relative}>
              {foot.relative}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export function QuotaRowCells({ type, quota }: { type: QuotaProviderType; quota: unknown }) {
  const { t, i18n } = useTranslation();
  const now = useNow();
  const urgentRowId = useMemo(
    () => pickUrgentRowId(collectQuotaRowInstants(type, quota), now),
    [type, quota, now]
  );

  if (type === 'claude') {
    const claude = quota as ClaudeQuotaState;
    const extra = claude.extraUsage?.is_enabled ? claude.extraUsage : null;
    return (
      <>
        {(claude.windows ?? []).map((window) => (
          <WindowCell
            key={window.id}
            window={window}
            soon={window.id === urgentRowId}
            nowMs={now}
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

  const codex = quota as CodexQuotaState;
  const available = codex.rateLimitResetCreditsAvailableCount ?? null;
  // The credit that expires first is the one worth spending first.
  const credits = (codex.rateLimitResetCredits ?? [])
    .map((credit, index) => ({ credit, index, atMs: parseIsoToMs(credit.expiresAt) }))
    .filter((item) => item.credit.status === 'available' && item.atMs !== null)
    .sort((a, b) => (a.atMs as number) - (b.atMs as number));
  const next = credits[0];
  const nextDisplay = next ? buildResetDisplay(null, next.atMs, now, i18n.resolvedLanguage) : null;

  return (
    <>
      {(codex.windows ?? []).map((window) => (
        <WindowCell key={window.id} window={window} soon={window.id === urgentRowId} nowMs={now} />
      ))}
      {available !== null && (
        <StatCell
          label={t('codex_quota.reset_credits_label')}
          value={
            <>
              <strong>{available}</strong> {t('quota_management.row_available')}
            </>
          }
          soon={Boolean(next) && resetCreditRowId(next.credit, next.index) === urgentRowId}
          foot={
            next && nextDisplay
              ? {
                  text: t('codex_quota.reset_credit_number', { index: next.index + 1 }),
                  relative: nextDisplay.relative ?? nextDisplay.absolute,
                }
              : null
          }
        />
      )}
    </>
  );
}
