import { useTranslation } from 'react-i18next';
import { Input } from '@/components/ui/Input';
import { CONFIG_TAB_ICONS, SECTION_INDEX_LABELS } from '../../constants';
import type { ConfigSectionProps } from '../../types';
import { SectionCard } from '../SectionCard';
import {
  FieldAnchor,
  FieldGrid,
  FieldGroup,
  FieldStack,
  ToggleRow,
} from '../fields/FieldPrimitives';
import { QuotaSwitchPreviewModelToggle, QuotaSwitchProjectToggle } from '../fields/sharedFields';
import { getValidationMessage } from '../blocks/shared';

const Icon = CONFIG_TAB_ICONS.quota;

/** 04 Quota fallback: what happens when quota runs out, plus Codex usage-limit defaults. */
export function SectionQuota({
  values,
  validationErrors,
  disabled,
  animateIn,
  onChange,
}: ConfigSectionProps) {
  const { t } = useTranslation();
  const reserveError = getValidationMessage(t, validationErrors?.quotaCodexReservePercent);

  return (
    <SectionCard
      indexLabel={SECTION_INDEX_LABELS.quota}
      icon={<Icon size={16} />}
      title={t('config_management.visual.sections.quota.title')}
      description={t('config_management.visual.sections.quota.description')}
      animateIn={animateIn}
    >
      <FieldStack>
        <FieldGrid>
          <QuotaSwitchProjectToggle values={values} disabled={disabled} onChange={onChange} />
          <QuotaSwitchPreviewModelToggle values={values} disabled={disabled} onChange={onChange} />
          <FieldAnchor fieldId="quotaAntigravityCredits">
            <ToggleRow
              title={t('config_management.visual.sections.quota.antigravity_credits')}
              checked={values.quotaAntigravityCredits}
              disabled={disabled}
              onChange={(quotaAntigravityCredits) => onChange({ quotaAntigravityCredits })}
            />
          </FieldAnchor>
        </FieldGrid>

        {/* Global defaults only; per-account overrides live on the Quota page. */}
        <FieldGroup
          title={t('config_management.visual.sections.quota.codex_limits_title')}
          description={t('config_management.visual.sections.quota.codex_limits_desc')}
        >
          <FieldGrid>
            <FieldAnchor fieldId="quotaCodexReservePercent">
              <Input
                label={t('config_management.visual.sections.quota.codex_reserve_percent')}
                type="number"
                min={0}
                max={100}
                step={1}
                placeholder="0"
                value={values.quotaCodexReservePercent}
                onChange={(e) => onChange({ quotaCodexReservePercent: e.target.value })}
                disabled={disabled}
                error={reserveError}
                hint={t('config_management.visual.sections.quota.codex_reserve_percent_desc')}
              />
            </FieldAnchor>
            <FieldAnchor fieldId="quotaCodexDailyPacing">
              <ToggleRow
                title={t('config_management.visual.sections.quota.codex_daily_pacing')}
                description={t('config_management.visual.sections.quota.codex_daily_pacing_desc')}
                checked={values.quotaCodexDailyPacing}
                disabled={disabled}
                onChange={(quotaCodexDailyPacing) => onChange({ quotaCodexDailyPacing })}
              />
            </FieldAnchor>
          </FieldGrid>
        </FieldGroup>
      </FieldStack>
    </SectionCard>
  );
}
