import type { TFunction } from 'i18next';
import type { ClaudeQuotaState, CodexQuotaState } from '@/types';
import { buildResetDisplay, resolveResetMs } from '@/utils/quota';
import { formatDateTimeValue } from '@/utils/format';
import { getCodexPlanLabel } from '../providers/codex/planLabel';
import type { QuotaProviderType } from '../providers/types';

export const hasRowCells = (type: QuotaProviderType): boolean =>
  type === 'claude' || type === 'codex';

/** Small account details shown below the credential name. */
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
      if (display) parts.push(t('quota_management.row_renews', { date: display.absolute }));
    }
    return parts;
  }

  return [];
}
