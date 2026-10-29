/**
 * One credential as a table-like row: identity | usage-window cells | actions.
 *
 * Rows stay compact with a couple of credentials and scale to dozens without
 * changing shape. Claude and Codex render row-native cells (QuotaRowCells);
 * other providers reuse their card body with its top-level children laid out
 * as column cells (QuotaRowBody.module.scss).
 *
 * - idle: an inline load button while the automatic request starts;
 * - loading: ghost cells (aria-busy, visually hidden text equivalent);
 * - error: inline failure text, refresh retries;
 * - success: the provider body.
 *
 * Codex and Claude rows also carry the usage-limits action and, while the
 * proxy holds the credential back, a "paused" badge under the name.
 */

import { useTranslation } from 'react-i18next';
import { IconRefreshCw } from '@/components/ui/icons';
import type { ClaudeQuotaState, ResolvedTheme } from '@/types';
import { buildResetDisplay, resolveQuotaErrorMessage } from '@/utils/quota';
import {
  getAuthFileIcon,
  getThemeSurfaceIconBackground,
  getTypeLabel,
  isThemeSurfaceIconProvider,
} from '@/features/authFiles/constants';
import { bindQuotaClasses, type QuotaClassMap } from '../types';
import { QUOTA_ADAPTERS, type QuotaCardState } from '../providers';
import { isQuotaRefreshDisabled, type QuotaFileEntry } from '../logic';
import { hasClaudeUsageData } from '../providers/claude/data';
import type { ModelRestriction } from '../modelAccess';
import { UsageLimitsAction, type UsageLimitQuota } from '../usageLimits/UsageLimitsAction';
import { readUsageLimitPause, usageLimitProviderOf } from '../usageLimits/model';
import { useNow } from '@/hooks/useNow';
import { QuotaRowCells } from './QuotaRowCells';
import { hasRowCells, rowSubtitleParts } from './rowCellModel';
import bodyStyles from './QuotaBody.module.scss';
import rowBodyStyles from './QuotaRowBody.module.scss';
import styles from './QuotaRow.module.scss';

const ROW_LAYOUT_KEYS = [
  'quotaRow',
  'quotaRowHeader',
  'quotaModel',
  'quotaMeta',
  'quotaPercent',
  'quotaReset',
  'quotaResetRelative',
  'quotaMessage',
  'antigravityQuotaGroup',
  'antigravityQuotaGroupHeader',
] as const satisfies readonly (keyof QuotaClassMap)[];

/** Keys that keep their card styling and only gain row placement on top. */
const ROW_PLACEMENT_KEYS = [
  'quotaBar',
  'codexPlan',
  'codexResetCredits',
  'codexResetCreditsError',
  'codexUsageLimitPause',
  'quotaResetRelativeSoon',
] as const satisfies readonly (keyof QuotaClassMap)[];

/** Full-page skin with the layout keys swapped for their row-cell variants. */
const rowQuotaClasses: QuotaClassMap = (() => {
  const base = bindQuotaClasses(bodyStyles, 'QuotaBody.module.scss');
  const missing = [...ROW_LAYOUT_KEYS, ...ROW_PLACEMENT_KEYS].filter((key) => !rowBodyStyles[key]);
  if (missing.length > 0) {
    throw new Error(`[quota] QuotaRowBody.module.scss is missing: ${missing.join(', ')}`);
  }
  const next = { ...base };
  ROW_LAYOUT_KEYS.forEach((key) => {
    next[key] = rowBodyStyles[key];
  });
  ROW_PLACEMENT_KEYS.forEach((key) => {
    next[key] = `${base[key]} ${rowBodyStyles[key]}`;
  });
  return next;
})();

export type QuotaRowProps = {
  entry: QuotaFileEntry;
  quota?: QuotaCardState;
  displayName: string;
  restrictions: ModelRestriction[];
  resolvedTheme: ResolvedTheme;
  /** Grouped views already name the provider in the section header. */
  showProviderIcon: boolean;
  canRefresh: boolean;
  resetting: boolean;
  onRefresh: () => void;
  onReset: () => void;
  /** Codex / Claude: whether the usage-limits dialog can save right now. */
  canEditUsageLimits?: boolean;
  /** Codex / Claude: reloads the credential list after usage limits are saved. */
  onUsageLimitsSaved?: () => void | Promise<void>;
};

export function QuotaRow(props: QuotaRowProps) {
  const {
    entry,
    quota,
    displayName,
    restrictions,
    resolvedTheme,
    showProviderIcon,
    canRefresh,
    resetting,
    onRefresh,
    onReset,
    canEditUsageLimits = false,
    onUsageLimitsSaved,
  } = props;
  const { t, i18n } = useTranslation();
  const now = useNow();
  const adapter = QUOTA_ADAPTERS[entry.type];
  const subtitle = rowSubtitleParts(entry.type, quota, t, now, i18n.resolvedLanguage);
  const visibleRestrictions = restrictions.filter(
    (restriction) => !(entry.type === 'claude' && restriction.model === 'Fable 5.1')
  );
  const usageLimitProvider = usageLimitProviderOf(entry.type);
  const usageLimitPause = usageLimitProvider ? readUsageLimitPause(entry.file, now) : null;
  const usageLimitPauseDisplay = usageLimitPause
    ? buildResetDisplay(null, usageLimitPause.untilMs, now, i18n.resolvedLanguage)
    : null;

  const status = quota?.status ?? 'idle';
  const loading = status === 'loading';
  // Claude keeps its last observation on screen while refreshing or after a failed read.
  const retainedClaudeUsage =
    entry.type === 'claude' && hasClaudeUsageData(quota as ClaudeQuotaState | undefined);
  // Plugin quotas show the provider they report for, not the generic plugin type.
  const file = entry.file;
  const providerType =
    entry.type === 'plugin'
      ? String(
          file.quotaProvider ?? file['quota_provider'] ?? file.provider ?? file.type ?? 'plugin'
        )
      : entry.type;
  const iconSrc = getAuthFileIcon(providerType, resolvedTheme);
  const typeLabel = getTypeLabel(t, providerType);
  const errorMessage = resolveQuotaErrorMessage(
    t,
    quota?.errorStatus,
    quota?.error || t('common.unknown_error')
  );
  const showReset =
    status === 'success' &&
    Boolean(adapter.resetQuota) &&
    quota !== undefined &&
    Boolean(adapter.canResetQuota?.(quota));

  return (
    <li className={styles.row}>
      <div className={styles.identity}>
        <div className={styles.nameLine}>
          {showProviderIcon && (
            <span
              className={styles.iconWrap}
              title={typeLabel}
              style={
                isThemeSurfaceIconProvider(providerType)
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
          )}
          <span className={styles.name} title={displayName}>
            {displayName}
          </span>
        </div>
        {(subtitle.length > 0 || visibleRestrictions.length > 0 || usageLimitPauseDisplay) && (
          <div className={styles.subtitle}>
            {subtitle.length > 0 && (
              <span className={styles.subtitleText} title={subtitle.join(' · ')}>
                {subtitle.join(' · ')}
              </span>
            )}
            {visibleRestrictions.map((restriction) => (
              <span
                key={restriction.model}
                className={styles.restrictedBadge}
                title={t(
                  restriction.source === 'plan'
                    ? 'quota_management.model_restricted_plan_hint'
                    : 'quota_management.model_restricted_reported_hint',
                  { model: restriction.model }
                )}
              >
                {t('quota_management.model_restricted', { model: restriction.model })}
              </span>
            ))}
            {usageLimitPause && usageLimitPauseDisplay && (
              <span
                className={styles.usageLimitBadge}
                title={[
                  t('quota_management.usage_limits.paused_until', {
                    time: usageLimitPauseDisplay.absolute,
                  }),
                  usageLimitPause.reason,
                ]
                  .filter(Boolean)
                  .join('\n')}
              >
                {t('quota_management.usage_limits.paused_badge', {
                  time: usageLimitPauseDisplay.relative ?? usageLimitPauseDisplay.absolute,
                })}
              </span>
            )}
          </div>
        )}
      </div>

      <div className={styles.cells}>
        {status === 'idle' ? (
          <button
            type="button"
            className={styles.idleButton}
            onClick={onRefresh}
            disabled={!canRefresh}
          >
            <IconRefreshCw size={13} aria-hidden="true" />
            {t(`${adapter.i18nPrefix}.idle`)}
          </button>
        ) : loading && !retainedClaudeUsage ? (
          <>
            <span className={styles.srOnly}>{t(`${adapter.i18nPrefix}.loading`)}</span>
            {[0, 1].map((cell) => (
              <div key={cell} className={styles.skeletonCell} aria-hidden="true">
                <span className={styles.skeletonLabel} />
                <span className={styles.skeletonTrack} />
              </div>
            ))}
          </>
        ) : status === 'error' && !retainedClaudeUsage ? (
          <div className={styles.errorText} role="alert">
            {t(`${adapter.i18nPrefix}.load_failed`, { message: errorMessage })}
          </div>
        ) : quota && hasRowCells(entry.type) ? (
          <>
            {status === 'error' && (
              <div className={styles.errorText} role="alert">
                {t(`${adapter.i18nPrefix}.load_failed`, { message: errorMessage })}
              </div>
            )}
            <QuotaRowCells type={entry.type} quota={quota} file={entry.file} />
          </>
        ) : quota ? (
          <adapter.Body quota={quota} classes={rowQuotaClasses} file={entry.file} />
        ) : null}
      </div>

      <div className={styles.actions}>
        {usageLimitProvider && onUsageLimitsSaved && (
          <UsageLimitsAction
            provider={usageLimitProvider}
            file={entry.file}
            displayName={displayName}
            quota={quota as UsageLimitQuota | undefined}
            disabled={!canEditUsageLimits}
            onSaved={onUsageLimitsSaved}
            className={styles.actionButton}
          />
        )}
        {showReset && (
          <button
            type="button"
            className={styles.actionButton}
            onClick={onReset}
            disabled={!canRefresh || loading || resetting}
            title={t(`${adapter.i18nPrefix}.reset_button`)}
          >
            <IconRefreshCw size={13} className={resetting ? styles.spinning : undefined} />
            {t(`${adapter.i18nPrefix}.reset_button`)}
          </button>
        )}
        {status !== 'idle' && (
          <button
            type="button"
            className={styles.actionButton}
            onClick={onRefresh}
            disabled={isQuotaRefreshDisabled(canRefresh, loading, resetting)}
            title={t('auth_files.quota_refresh_hint')}
          >
            <IconRefreshCw size={13} className={loading ? styles.spinning : undefined} />
            {t('auth_files.quota_refresh_single')}
          </button>
        )}
      </div>
    </li>
  );
}
