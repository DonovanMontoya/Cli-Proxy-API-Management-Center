import { useTranslation } from 'react-i18next';
import { CONFIG_TAB_ICONS, SECTION_INDEX_LABELS } from '../../constants';
import type { ConfigSectionProps } from '../../types';
import { goDurationSeconds } from '../../visualConfigAdditions';
import { SectionCard } from '../SectionCard';
import { SettingList, TextSetting, ToggleSetting } from '../fields/FieldPrimitives';
import { getValidationMessage } from '../blocks/shared';

const Icon = CONFIG_TAB_ICONS.quota;

/**
 * 04 Quota: credential cooldown probing, banked reset auto-use, and the global
 * Codex / Claude usage-limit defaults (reserve and daily pacing).
 */
export function SectionQuota({
  values,
  validationErrors,
  disabled,
  animateIn,
  onChange,
}: ConfigSectionProps) {
  const { t } = useTranslation();
  const codexReserveError = getValidationMessage(t, validationErrors?.quotaCodexReservePercent);
  const claudeReserveError = getValidationMessage(t, validationErrors?.quotaClaudeReservePercent);
  const probeIntervalError = getValidationMessage(
    t,
    validationErrors?.quotaCredentialProbeInterval
  );
  const bankedResetError = getValidationMessage(t, validationErrors?.quotaBankedResetAutoUseBefore);
  // Empty / zero durations turn the feature off; flag that inside the input.
  const disabledBadge = t('config_management.visual.sections.streaming.disabled');
  const isOffDuration = (value: string, error?: string) =>
    !error && (!value.trim() || goDurationSeconds(value.trim()) === 0);

  return (
    <SectionCard
      indexLabel={SECTION_INDEX_LABELS.quota}
      icon={<Icon size={16} />}
      title={t('config_management.visual.sections.quota.title')}
      description={t('config_management.visual.sections.quota.description')}
      animateIn={animateIn}
    >
      <SettingList>
        <TextSetting
          fieldId="quotaCredentialProbeInterval"
          size="sm"
          label={t('config_management.visual.sections.quota.credential_probe_interval')}
          description={t('config_management.visual.sections.quota.credential_probe_interval_desc')}
          placeholder="0"
          value={values.quotaCredentialProbeInterval}
          onChange={(quotaCredentialProbeInterval) => onChange({ quotaCredentialProbeInterval })}
          disabled={disabled}
          error={probeIntervalError}
          adornment={
            isOffDuration(values.quotaCredentialProbeInterval, probeIntervalError)
              ? disabledBadge
              : undefined
          }
        />
        <TextSetting
          fieldId="quotaBankedResetAutoUseBefore"
          size="sm"
          label={t('config_management.visual.sections.quota.banked_reset_auto_use_before')}
          description={t(
            'config_management.visual.sections.quota.banked_reset_auto_use_before_desc'
          )}
          placeholder="0"
          value={values.quotaBankedResetAutoUseBefore}
          onChange={(quotaBankedResetAutoUseBefore) => onChange({ quotaBankedResetAutoUseBefore })}
          disabled={disabled}
          error={bankedResetError}
          adornment={
            isOffDuration(values.quotaBankedResetAutoUseBefore, bankedResetError)
              ? disabledBadge
              : undefined
          }
        />
      </SettingList>

      {/* Global defaults only; per-account overrides live on the Quota page.
          Codex and Claude defaults are independent. */}
      <SettingList
        title={t('config_management.visual.sections.quota.codex_limits_title')}
        description={t('config_management.visual.sections.quota.codex_limits_desc')}
      >
        <TextSetting
          fieldId="quotaCodexReservePercent"
          size="sm"
          label={t('config_management.visual.sections.quota.codex_reserve_percent')}
          description={t('config_management.visual.sections.quota.codex_reserve_percent_desc')}
          type="number"
          min={0}
          max={100}
          placeholder="0"
          value={values.quotaCodexReservePercent}
          onChange={(quotaCodexReservePercent) => onChange({ quotaCodexReservePercent })}
          disabled={disabled}
          error={codexReserveError}
        />
        <ToggleSetting
          fieldId="quotaCodexDailyPacing"
          label={t('config_management.visual.sections.quota.codex_daily_pacing')}
          description={t('config_management.visual.sections.quota.codex_daily_pacing_desc')}
          checked={values.quotaCodexDailyPacing}
          disabled={disabled}
          onChange={(quotaCodexDailyPacing) => onChange({ quotaCodexDailyPacing })}
        />
      </SettingList>

      <SettingList
        title={t('config_management.visual.sections.quota.claude_limits_title')}
        description={t('config_management.visual.sections.quota.claude_limits_desc')}
      >
        <TextSetting
          fieldId="quotaClaudeReservePercent"
          size="sm"
          label={t('config_management.visual.sections.quota.claude_reserve_percent')}
          description={t('config_management.visual.sections.quota.claude_reserve_percent_desc')}
          type="number"
          min={0}
          max={100}
          placeholder="0"
          value={values.quotaClaudeReservePercent}
          onChange={(quotaClaudeReservePercent) => onChange({ quotaClaudeReservePercent })}
          disabled={disabled}
          error={claudeReserveError}
        />
        <ToggleSetting
          fieldId="quotaClaudeDailyPacing"
          label={t('config_management.visual.sections.quota.claude_daily_pacing')}
          description={t('config_management.visual.sections.quota.claude_daily_pacing_desc')}
          checked={values.quotaClaudeDailyPacing}
          disabled={disabled}
          onChange={(quotaClaudeDailyPacing) => onChange({ quotaClaudeDailyPacing })}
        />
      </SettingList>
    </SectionCard>
  );
}
