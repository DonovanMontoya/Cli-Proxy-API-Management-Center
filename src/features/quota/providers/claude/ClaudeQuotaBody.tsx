/**
 * Claude quota body: plan / extra usage / banked reset chips + usage window meters.
 */

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { ClaudeQuotaState } from '@/types';
import { buildResetDisplay, formatInstantShort, parseIsoToMs } from '@/utils/quota';
import { resolveTimeZoneLabel } from '@/utils/time/timezone';
import { useNow } from '@/hooks/useNow';
import { QuotaMeter } from '../../components/QuotaMeter';
import { QuotaResetLabel } from '../../components/QuotaResetLabel';
import { collectQuotaRowInstants, pickUrgentRowId, resetCreditRowId } from '../../resetSchedule';
import type { QuotaBodyProps } from '../../types';

export function ClaudeQuotaBody({ quota, classes }: QuotaBodyProps<ClaudeQuotaState>) {
  const { t, i18n } = useTranslation();
  const now = useNow();
  const soonestRowId = useMemo(
    () => pickUrgentRowId(collectQuotaRowInstants('claude', quota), now),
    [quota, now]
  );
  const windows = quota.windows ?? [];
  const extraUsage = quota.extraUsage ?? null;
  const planType = quota.planType ?? null;
  const resetCount = quota.rateLimitResetCreditsAvailableCount ?? null;
  const resetCredits = quota.rateLimitResetCredits ?? [];

  return (
    <>
      {planType && (
        <div className={classes.codexPlan}>
          <span className={classes.codexPlanLabel}>{t('claude_quota.plan_label')}</span>
          <span className={classes.codexPlanValue}>{t(`claude_quota.${planType}`)}</span>
        </div>
      )}
      {extraUsage && extraUsage.is_enabled && (
        <div className={classes.codexPlan}>
          <span className={classes.codexPlanLabel}>{t('claude_quota.extra_usage_label')}</span>
          <span className={classes.codexPlanValue}>
            {`$${(extraUsage.used_credits / 100).toFixed(2)} / $${(extraUsage.monthly_limit / 100).toFixed(2)}`}
          </span>
        </div>
      )}
      {resetCount !== null && (
        <div className={classes.codexPlan}>
          <span className={classes.codexPlanLabel}>{t('claude_quota.reset_credits_label')}</span>
          <span className={classes.codexPlanValue}>{resetCount.toString()}</span>
        </div>
      )}
      {resetCredits.length > 0 && (
        <div className={classes.codexResetCredits}>
          <div className={classes.codexResetCreditsTitle}>
            {t('claude_quota.reset_credits_expiry_label', { timezone: resolveTimeZoneLabel() })}
          </div>
          {resetCredits.map((credit, index) => {
            const expiresAtMs = parseIsoToMs(credit.expiresAt);
            const expiresDisplay = buildResetDisplay(
              expiresAtMs === null ? credit.expiresAt : formatInstantShort(expiresAtMs),
              expiresAtMs,
              now,
              i18n.resolvedLanguage
            );
            const rowId = resetCreditRowId(credit, index);
            const soon = rowId === soonestRowId;
            return (
              <div
                key={rowId}
                className={
                  soon
                    ? `${classes.codexResetCreditRow} ${classes.codexResetCreditRowSoon}`
                    : classes.codexResetCreditRow
                }
                title={soon ? t('quota_management.soonest_row_hint') : undefined}
              >
                <span className={classes.codexResetCreditLabel}>
                  {t('claude_quota.reset_credit_number', { index: index + 1 })}
                  {credit.resetsLeft > 1 && ` ×${credit.resetsLeft}`}
                </span>
                <span className={classes.codexResetCreditTime}>
                  {expiresDisplay && (
                    <QuotaResetLabel display={expiresDisplay} classes={classes} soon={soon} />
                  )}
                </span>
              </div>
            );
          })}
        </div>
      )}
      {windows.length === 0 ? (
        <div className={classes.quotaMessage}>{t('claude_quota.empty_windows')}</div>
      ) : (
        windows.map((window, index) => {
          const used = window.usedPercent;
          const clampedUsed = used === null ? null : Math.max(0, Math.min(100, used));
          const remaining =
            clampedUsed === null ? null : Math.max(0, Math.min(100, 100 - clampedUsed));
          const percentLabel = remaining === null ? '--' : `${Math.round(remaining)}%`;
          const windowLabel = window.labelKey ? t(window.labelKey) : window.label;
          const resetDisplay = buildResetDisplay(
            window.resetLabel,
            window.resetAtMs,
            now,
            i18n.resolvedLanguage
          );

          const soon = window.id === soonestRowId;

          return (
            <div
              key={window.id}
              className={classes.quotaRow}
              title={soon ? t('quota_management.soonest_row_hint') : undefined}
            >
              <div className={classes.quotaRowHeader}>
                <span className={classes.quotaModel}>{windowLabel}</span>
                <div className={classes.quotaMeta}>
                  <span className={classes.quotaPercent}>{percentLabel}</span>
                  {resetDisplay && (
                    <QuotaResetLabel display={resetDisplay} classes={classes} soon={soon} />
                  )}
                </div>
              </div>
              <QuotaMeter percent={remaining} classes={classes} index={index} />
            </div>
          );
        })
      )}
    </>
  );
}
