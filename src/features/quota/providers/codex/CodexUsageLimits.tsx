/**
 * Per-credential Codex usage limits: a row action that opens a small dialog
 * for the reserve and daily pacing overrides.
 *
 * Each override is either inherited from the global quota-exceeded default
 * (saved as null) or pinned on this credential. The preview below the
 * controls replays the proxy's math on the credential's loaded weekly window,
 * so the effect of a change is visible before it is saved.
 */

import { useId, useMemo, useState } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { IconSlidersHorizontal } from '@/components/ui/icons';
import { Modal } from '@/components/ui/Modal';
import { useNow } from '@/hooks/useNow';
import { authFilesApi } from '@/services/api';
import { useNotificationStore } from '@/stores';
import type { AuthFileItem, CodexQuotaState } from '@/types';
import { getErrorMessage } from '@/utils/helpers';
import { buildResetDisplay } from '@/utils/quota';
import {
  QUOTA_PROGRESS_HIGH_THRESHOLD,
  QUOTA_PROGRESS_MEDIUM_THRESHOLD,
  QuotaMeterMarkers,
} from '../../components/QuotaMeter';
import { withMarkerHost } from '../../components/meterMarkers';
import {
  CODEX_RESERVE_MAX_PERCENT,
  buildCodexUsageLimitPatch,
  computeCodexDailyPace,
  formatLimitPercent,
  isCodexReserveReached,
  isCodexUsageLimitActive,
  isCodexUsageLimitWindow,
  pickCodexPacedWindow,
  readCodexUsageLimitOverrides,
  resolveCodexUsageLimitPolicy,
  type CodexUsageLimitOverrides,
  type CodexUsageLimitPolicy,
} from './usageLimits';
import {
  useCodexMeterMarkers,
  useCodexUsageLimitDefaults,
  useCodexUsageLimitPolicy,
} from './useCodexUsageLimits';
import styles from './CodexUsageLimits.module.scss';

type PacingChoice = 'default' | 'on' | 'off';

const SUGGESTED_RESERVE_PERCENT = 10;

const pacingChoiceOf = (value: boolean | null): PacingChoice =>
  value === null ? 'default' : value ? 'on' : 'off';

const pacingValueOf = (choice: PacingChoice): boolean | null =>
  choice === 'default' ? null : choice === 'on';

/** "11%", or "Off" when there is no reserve. */
const reserveLabel = (percent: number, t: TFunction): string =>
  percent > 0
    ? t('codex_quota.limits.percent', { value: formatLimitPercent(percent) })
    : t('codex_quota.limits.off');

const toggleLabel = (enabled: boolean, t: TFunction): string =>
  enabled ? t('codex_quota.limits.on') : t('codex_quota.limits.off');

/** A custom reserve as typed: a number within 0..max, or null while invalid. */
const parseReserve = (text: string, max: number): number | null => {
  const trimmed = text.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value >= 0 && value <= max ? value : null;
};

export interface CodexUsageLimitsActionProps {
  file: AuthFileItem;
  displayName: string;
  quota?: CodexQuotaState;
  disabled: boolean;
  /** Reloads the credential list so the new overrides show up. */
  onSaved: () => void | Promise<void>;
  /** Class for the trigger, so it matches the host's action buttons. */
  className?: string;
}

export function CodexUsageLimitsAction({
  file,
  displayName,
  quota,
  disabled,
  onSaved,
  className,
}: CodexUsageLimitsActionProps) {
  const { t } = useTranslation();
  const policy = useCodexUsageLimitPolicy(file);
  const [open, setOpen] = useState(false);
  // A fresh key per opening resets the draft to the saved values.
  const [session, setSession] = useState(0);
  const active = policy !== null && isCodexUsageLimitActive(policy);
  const summary = useMemo(() => (policy ? describePolicy(policy, t) : ''), [policy, t]);

  return (
    <>
      <button
        type="button"
        className={className}
        data-active={active ? 'true' : undefined}
        onClick={() => {
          setSession((value) => value + 1);
          setOpen(true);
        }}
        disabled={disabled}
        title={summary}
        aria-haspopup="dialog"
      >
        <IconSlidersHorizontal size={13} aria-hidden="true" />
        {t('codex_quota.limits.button')}
      </button>
      {/* Mounted on first open only, so idle rows skip the dialog body on every tick. */}
      {session > 0 && (
        <CodexUsageLimitsDialog
          key={session}
          open={open}
          file={file}
          displayName={displayName}
          quota={quota}
          onClose={() => setOpen(false)}
          onSaved={onSaved}
        />
      )}
    </>
  );
}

function describePolicy(policy: CodexUsageLimitPolicy, t: TFunction): string {
  return t('codex_quota.limits.summary', {
    reserve: reserveLabel(policy.reservePercent, t),
    pacing: toggleLabel(policy.dailyPacing, t),
  });
}

interface CodexUsageLimitsDialogProps {
  open: boolean;
  file: AuthFileItem;
  displayName: string;
  quota?: CodexQuotaState;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}

function CodexUsageLimitsDialog({
  open,
  file,
  displayName,
  quota,
  onClose,
  onSaved,
}: CodexUsageLimitsDialogProps) {
  const { t, i18n } = useTranslation();
  const showNotification = useNotificationStore((state) => state.showNotification);
  const now = useNow();
  const defaults = useCodexUsageLimitDefaults();
  const reserveHelpId = useId();

  const saved = readCodexUsageLimitOverrides(file);
  const reserveMax = Math.max(CODEX_RESERVE_MAX_PERCENT, Math.ceil(saved.reservePercent ?? 0));
  const [reserveCustom, setReserveCustom] = useState(saved.reservePercent !== null);
  // Switching to a custom reserve starts from the default, or a suggestion when it is off.
  const [reserveText, setReserveText] = useState(() =>
    formatLimitPercent(
      saved.reservePercent ??
        (defaults.reservePercent > 0 ? defaults.reservePercent : SUGGESTED_RESERVE_PERCENT)
    )
  );
  const [pacingChoice, setPacingChoice] = useState<PacingChoice>(() =>
    pacingChoiceOf(saved.dailyPacing)
  );
  const [saving, setSaving] = useState(false);

  const customReserve = parseReserve(reserveText, reserveMax);
  const reserveInvalid = reserveCustom && customReserve === null;
  const draft: CodexUsageLimitOverrides = {
    reservePercent: reserveCustom ? customReserve : null,
    dailyPacing: pacingValueOf(pacingChoice),
  };
  const policy = resolveCodexUsageLimitPolicy(defaults, draft);
  const patch = reserveInvalid ? null : buildCodexUsageLimitPatch(saved, draft);

  const handleSave = async () => {
    if (!patch || saving) return;
    setSaving(true);
    try {
      await authFilesApi.patchFields(file.name, patch);
      showNotification(t('codex_quota.limits.save_success', { name: displayName }), 'success');
      onClose();
      await onSaved();
    } catch (err: unknown) {
      const message = getErrorMessage(err, t('common.unknown_error'));
      showNotification(
        t('codex_quota.limits.save_failed', { name: displayName, message }),
        'error'
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={460}
      closeDisabled={saving}
      title={t('codex_quota.limits.title')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => void handleSave()} disabled={!patch} loading={saving}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className={styles.body}>
        <p className={styles.intro}>
          <span className={styles.account} title={displayName}>
            {displayName}
          </span>
          {t('codex_quota.limits.description')}
        </p>

        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <span className={styles.sectionTitle}>{t('codex_quota.limits.reserve_label')}</span>
            <EffectiveChip
              value={reserveLabel(policy.reservePercent, t)}
              inherited={policy.reserveInherited}
            />
          </div>
          <Segmented
            label={t('codex_quota.limits.reserve_label')}
            value={reserveCustom ? 'custom' : 'default'}
            disabled={saving}
            options={[
              {
                value: 'default',
                label: t('codex_quota.limits.use_default', {
                  value: reserveLabel(defaults.reservePercent, t),
                }),
              },
              { value: 'custom', label: t('codex_quota.limits.custom') },
            ]}
            onChange={(next) => setReserveCustom(next === 'custom')}
          />
          <div className={styles.reserveControls}>
            <input
              type="range"
              className={styles.slider}
              min={0}
              max={reserveMax}
              step={1}
              value={reserveCustom ? (customReserve ?? 0) : defaults.reservePercent}
              onChange={(event) => setReserveText(event.target.value)}
              disabled={!reserveCustom || saving}
              aria-label={t('codex_quota.limits.reserve_label')}
              aria-describedby={reserveHelpId}
            />
            <div className={styles.numberField}>
              <input
                type="number"
                inputMode="decimal"
                className={`input ${styles.numberInput}`}
                min={0}
                max={reserveMax}
                step={1}
                value={reserveCustom ? reserveText : formatLimitPercent(defaults.reservePercent)}
                onChange={(event) => setReserveText(event.target.value)}
                disabled={!reserveCustom || saving}
                aria-label={t('codex_quota.limits.reserve_input_label')}
                aria-invalid={reserveInvalid || undefined}
                aria-describedby={reserveHelpId}
              />
              <span className={styles.numberSuffix} aria-hidden="true">
                %
              </span>
            </div>
          </div>
          <p
            id={reserveHelpId}
            className={reserveInvalid ? styles.error : styles.help}
            role={reserveInvalid ? 'alert' : undefined}
          >
            {reserveInvalid
              ? t('codex_quota.limits.reserve_invalid', { max: reserveMax })
              : t('codex_quota.limits.reserve_help')}
          </p>
        </section>

        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <span className={styles.sectionTitle}>{t('codex_quota.limits.pacing_label')}</span>
            <EffectiveChip
              value={toggleLabel(policy.dailyPacing, t)}
              inherited={policy.pacingInherited}
            />
          </div>
          <Segmented
            label={t('codex_quota.limits.pacing_label')}
            value={pacingChoice}
            disabled={saving}
            options={[
              {
                value: 'default',
                label: t('codex_quota.limits.use_default', {
                  value: toggleLabel(defaults.dailyPacing, t),
                }),
              },
              { value: 'on', label: toggleLabel(true, t) },
              { value: 'off', label: toggleLabel(false, t) },
            ]}
            onChange={setPacingChoice}
          />
          <p className={styles.help}>{t('codex_quota.limits.pacing_help')}</p>
        </section>

        <UsageLimitPreview
          policy={policy}
          quota={quota}
          nowMs={now}
          locale={i18n.resolvedLanguage}
        />
      </div>
    </Modal>
  );
}

function EffectiveChip({ value, inherited }: { value: string; inherited: boolean }) {
  const { t } = useTranslation();
  return (
    <span className={styles.effective}>
      <span className={styles.effectiveValue}>{value}</span>
      <span className={styles.effectiveSource}>
        {inherited
          ? t('codex_quota.limits.source_default')
          : t('codex_quota.limits.source_account')}
      </span>
    </span>
  );
}

function Segmented<T extends string>({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  disabled: boolean;
  onChange: (value: T) => void;
}) {
  return (
    <div className={styles.segmented} role="group" aria-label={label}>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            className={active ? `${styles.segment} ${styles.segmentActive}` : styles.segment}
            aria-pressed={active}
            disabled={disabled}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/** What the draft policy means for the credential's loaded windows right now. */
function UsageLimitPreview({
  policy,
  quota,
  nowMs,
  locale,
}: {
  policy: CodexUsageLimitPolicy;
  quota?: CodexQuotaState;
  nowMs: number;
  locale?: string;
}) {
  const { t } = useTranslation();
  const markersFor = useCodexMeterMarkers(policy, nowMs);
  const windows = quota?.status === 'success' ? (quota.windows ?? []) : [];
  const pacedWindow = pickCodexPacedWindow(windows);
  const pace = pacedWindow ? computeCodexDailyPace(pacedWindow, policy, nowMs) : null;
  const reserveHits = windows.filter((window) => isCodexReserveReached(window, policy));
  const windowLabel = (window: (typeof windows)[number]) =>
    window.labelKey ? t(window.labelKey, window.labelParams ?? {}) : window.label;

  const lines: { key: string; text: string; warn?: boolean }[] = [];
  if (!isCodexUsageLimitActive(policy)) {
    lines.push({ key: 'inactive', text: t('codex_quota.limits.preview_inactive') });
  }
  if (policy.reservePercent > 0) {
    lines.push({
      key: 'reserve',
      text: t('codex_quota.limits.preview_keeps_free', {
        value: formatLimitPercent(policy.reservePercent),
      }),
    });
  }
  reserveHits.forEach((window) => {
    lines.push({
      key: `reserve-hit-${window.id}`,
      warn: true,
      text: t('codex_quota.limits.preview_reserve_reached', {
        window: windowLabel(window),
        remaining: formatLimitPercent(100 - (window.usedPercent ?? 0)),
      }),
    });
  });
  if (policy.dailyPacing) {
    if (pace) {
      lines.push({
        key: 'pace',
        warn: pace.reached,
        text: t('codex_quota.limits.preview_today', {
          used: formatLimitPercent(pace.usedPercent ?? 0),
          allowed: formatLimitPercent(pace.allowedUsedPercent),
          day: pace.day,
          days: pace.days,
        }),
      });
      const nextDay = buildResetDisplay(null, pace.nextDayAtMs, nowMs, locale);
      if (pace.reached && nextDay) {
        lines.push({
          key: 'pace-reached',
          warn: true,
          text: t('codex_quota.limits.preview_pace_reached', {
            time: nextDay.relative ?? nextDay.absolute,
          }),
        });
      }
      lines.push({
        key: 'pace-share',
        text: t('codex_quota.limits.preview_daily_share', {
          share: formatLimitPercent(pace.dailySharePercent),
        }),
      });
    } else {
      lines.push({ key: 'pace-missing', text: t('codex_quota.limits.preview_no_window') });
    }
  }

  const meterWindow =
    pacedWindow ?? windows.find((window) => isCodexUsageLimitWindow(window.id)) ?? null;
  const remaining =
    meterWindow?.usedPercent == null
      ? null
      : Math.max(0, Math.min(100, 100 - meterWindow.usedPercent));
  const markers = meterWindow ? markersFor(meterWindow) : [];
  const levelClass =
    remaining === null
      ? ''
      : remaining >= QUOTA_PROGRESS_HIGH_THRESHOLD
        ? styles.levelHigh
        : remaining >= QUOTA_PROGRESS_MEDIUM_THRESHOLD
          ? styles.levelMedium
          : styles.levelLow;

  return (
    <section className={styles.preview} aria-live="polite">
      <div className={styles.previewHead}>
        <span className={styles.sectionTitle}>{t('codex_quota.limits.preview_title')}</span>
        {meterWindow && (
          <span className={styles.previewWindow}>
            {windowLabel(meterWindow)}
            {remaining !== null && (
              <span className={styles.previewPercent}>
                {t('codex_quota.limits.preview_remaining', {
                  value: formatLimitPercent(remaining),
                })}
              </span>
            )}
          </span>
        )}
      </div>
      {meterWindow && (
        <div className={withMarkerHost(styles.meter, markers)}>
          <div
            className={`${styles.meterFill} ${levelClass}`}
            style={{ width: `${remaining ?? 0}%` }}
          />
          <QuotaMeterMarkers markers={markers} />
        </div>
      )}
      <ul className={styles.previewLines}>
        {lines.map((line) => (
          <li key={line.key} className={line.warn ? styles.previewWarn : undefined}>
            {line.text}
          </li>
        ))}
      </ul>
    </section>
  );
}
