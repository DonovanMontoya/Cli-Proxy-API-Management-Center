import { useTranslation } from 'react-i18next';
import { CONFIG_TAB_ICONS, SECTION_INDEX_LABELS } from '../../constants';
import type { ConfigSectionProps } from '../../types';
import { SectionCard } from '../SectionCard';
import { SettingList, TextSetting, ToggleSetting } from '../fields/FieldPrimitives';
import { getValidationMessage } from '../blocks/shared';

const Icon = CONFIG_TAB_ICONS.quota;

/** 04 Quota: global Codex / Claude usage-limit defaults (reserve and daily pacing). */
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

  return (
    <SectionCard
      indexLabel={SECTION_INDEX_LABELS.quota}
      icon={<Icon size={16} />}
      title={t('config_management.visual.sections.quota.title')}
      description={t('config_management.visual.sections.quota.description')}
      animateIn={animateIn}
    >
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
