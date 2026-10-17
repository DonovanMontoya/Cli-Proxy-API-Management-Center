/**
 * "Paused by usage limit until <time> · <countdown>" for provider card bodies,
 * with the proxy's reason as the tooltip. Renders nothing once the pause lifts.
 */

import { useTranslation } from 'react-i18next';
import type { AuthFileItem } from '@/types';
import { buildResetDisplay } from '@/utils/quota';
import { QuotaResetLabel } from '../components/QuotaResetLabel';
import type { QuotaClassMap } from '../types';
import { readUsageLimitPause } from './model';

export function UsageLimitPauseLine({
  file,
  classes,
  nowMs,
}: {
  file?: AuthFileItem;
  classes: QuotaClassMap;
  nowMs: number;
}) {
  const { t, i18n } = useTranslation();
  const pause = readUsageLimitPause(file, nowMs);
  const display = pause
    ? buildResetDisplay(null, pause.untilMs, nowMs, i18n.resolvedLanguage)
    : null;
  if (!pause || !display) return null;

  return (
    <div className={classes.codexUsageLimitPause} title={pause.reason || undefined}>
      <span>{t('quota_management.usage_limits.paused_label')}</span>
      <QuotaResetLabel display={display} classes={classes} />
    </div>
  );
}
