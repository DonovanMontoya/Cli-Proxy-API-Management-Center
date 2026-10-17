/**
 * Per-credential usage limits (Codex, Claude): a row action that opens a small
 * dialog for the reserve and daily pacing overrides.
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
import type { AuthFileItem } from '@/types';
import { getErrorMessage } from '@/utils/helpers';
import { buildResetDisplay } from '@/utils/quota';
import {
  QUOTA_PROGRESS_HIGH_THRESHOLD,
  QUOTA_PROGRESS_MEDIUM_THRESHOLD,
  QuotaMeterMarkers,
} from '../components/QuotaMeter';
import { withMarkerHost } from '../components/meterMarkers';
import {
  USAGE_LIMIT_RESERVE_MAX_PERCENT,
  buildUsageLimitPatch,
  clampPercent,
  computeDailyPace,
  formatLimitPercent,
  isReserveReached,
  isUsageLimitActive,
  isUsageLimitWindow,
  pickPacedWindow,
  readUsageLimitOverrides,
  resolveUsageLimitPolicy,
  type UsageLimitOverrides,
  type UsageLimitPolicy,
  type UsageLimitProvider,
  type UsageLimitWindow,
} from './model';
import { useUsageLimitDefaults, useUsageLimitMarkers, useUsageLimitPolicy } from './useUsageLimits';
import styles from './UsageLimitsAction.module.scss';

interface UsageLimitPreviewWindow extends UsageLimitWindow {
  label: string;
  labelKey?: string;
  labelParams?: Record<string, string | number>;
}

/** The slice of a Codex / Claude quota state the preview reads. */
export interface UsageLimitQuota {
  status: string;
  windows?: UsageLimitPreviewWindow[];
}

type PacingChoice = 'default' | 'on' | 'off';

const SUGGESTED_RESERVE_PERCENT = 10;

const pacingChoiceOf = (value: boolean | null): PacingChoice =>
  value === null ? 'default' : value ? 'on' : 'off';

const pacingValueOf = (choice: PacingChoice): boolean | null =>
  choice === 'default' ? null : choice === 'on';

/** "11%", or "Off" when there is no reserve. */
const reserveLabel = (percent: number, t: TFunction): string =>
  percent > 0
    ? t('quota_management.usage_limits.percent', { value: formatLimitPercent(percent) })
    : t('quota_management.usage_limits.off');

const toggleLabel = (enabled: boolean, t: TFunction): string =>
  enabled ? t('quota_management.usage_limits.on') : t('quota_management.usage_limits.off');

/** A custom reserve as typed: a number within 0..max, or null while invalid. */
const parseReserve = (text: string, max: number): number | null => {
  const trimmed = text.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value >= 0 && value <= max ? value : null;
};

export interface UsageLimitsActionProps {
  provider: UsageLimitProvider;
  file: AuthFileItem;
  displayName: string;
  quota?: UsageLimitQuota;
  disabled: boolean;
  /** Reloads the credential list so the new overrides show up. */
  onSaved: () => void | Promise<void>;
  /** Class for the trigger, so it matches the host's action buttons. */
  className?: string;
}

export function UsageLimitsAction({
  provider,
  file,
  displayName,
  quota,
  disabled,
  onSaved,
  className,
}: UsageLimitsActionProps) {
  const { t } = useTranslation();
  const policy = useUsageLimitPolicy(provider, file);
  const [open, setOpen] = useState(false);
  // A fresh key per opening resets the draft to the saved values.
  const [session, setSession] = useState(0);
  const active = policy !== null && isUsageLimitActive(policy);
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
        {t('quota_management.usage_limits.button')}
      </button>
      {/* Mounted on first open only, so idle rows skip the dialog body on every tick. */}
      {session > 0 && (
        <UsageLimitsDialog
          key={session}
          provider={provider}
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

function describePolicy(policy: UsageLimitPolicy, t: TFunction): string {
  return t('quota_management.usage_limits.summary', {
    reserve: reserveLabel(policy.reservePercent, t),
    pacing: toggleLabel(policy.dailyPacing, t),
  });
}

interface UsageLimitsDialogProps {
  provider: UsageLimitProvider;
  open: boolean;
  file: AuthFileItem;
  displayName: string;
  quota?: UsageLimitQuota;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}

function UsageLimitsDialog({
  provider,
  open,
  file,
  displayName,
  quota,
  onClose,
  onSaved,
}: UsageLimitsDialogProps) {
  const { t, i18n } = useTranslation();
  const showNotification = useNotificationStore((state) => state.showNotification);
  const now = useNow();
  const defaults = useUsageLimitDefaults(provider);
  const reserveHelpId = useId();

  const saved = readUsageLimitOverrides(file);
  const reserveMax = Math.max(
    USAGE_LIMIT_RESERVE_MAX_PERCENT,
    Math.ceil(saved.reservePercent ?? 0)
  );
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
  const draft: UsageLimitOverrides = {
    reservePercent: reserveCustom ? customReserve : null,
    dailyPacing: pacingValueOf(pacingChoice),
  };
  const policy = resolveUsageLimitPolicy(provider, defaults, draft);
  const patch = reserveInvalid ? null : buildUsageLimitPatch(saved, draft);

  const handleSave = async () => {
    if (!patch || saving) return;
    setSaving(true);
    try {
      await authFilesApi.patchFields(file.name, patch);
      showNotification(
        t('quota_management.usage_limits.save_success', { name: displayName }),
        'success'
      );
      onClose();
      await onSaved();
    } catch (err: unknown) {
      const message = getErrorMessage(err, t('common.unknown_error'));
      showNotification(
        t('quota_management.usage_limits.save_failed', { name: displayName, message }),
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
      title={t('quota_management.usage_limits.title')}
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
          {t('quota_management.usage_limits.description')}
        </p>

        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <span className={styles.sectionTitle}>
              {t('quota_management.usage_limits.reserve_label')}
            </span>
            <EffectiveChip
              value={reserveLabel(policy.reservePercent, t)}
              inherited={policy.reserveInherited}
            />
          </div>
          <Segmented
            label={t('quota_management.usage_limits.reserve_label')}
            value={reserveCustom ? 'custom' : 'default'}
            disabled={saving}
            options={[
              {
                value: 'default',
                label: t('quota_management.usage_limits.use_default', {
                  value: reserveLabel(defaults.reservePercent, t),
                }),
              },
              { value: 'custom', label: t('quota_management.usage_limits.custom') },
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
              aria-label={t('quota_management.usage_limits.reserve_label')}
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
                aria-label={t('quota_management.usage_limits.reserve_input_label')}
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
              ? t('quota_management.usage_limits.reserve_invalid', { max: reserveMax })
              : t('quota_management.usage_limits.reserve_help')}
          </p>
        </section>

        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <span className={styles.sectionTitle}>
              {t('quota_management.usage_limits.pacing_label')}
            </span>
            <EffectiveChip
              value={toggleLabel(policy.dailyPacing, t)}
              inherited={policy.pacingInherited}
            />
          </div>
          <Segmented
            label={t('quota_management.usage_limits.pacing_label')}
            value={pacingChoice}
            disabled={saving}
            options={[
              {
                value: 'default',
                label: t('quota_management.usage_limits.use_default', {
                  value: toggleLabel(defaults.dailyPacing, t),
                }),
              },
              { value: 'on', label: toggleLabel(true, t) },
              { value: 'off', label: toggleLabel(false, t) },
            ]}
            onChange={setPacingChoice}
          />
          <p className={styles.help}>{t('quota_management.usage_limits.pacing_help')}</p>
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
          ? t('quota_management.usage_limits.source_default')
          : t('quota_management.usage_limits.source_account')}
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
  policy: UsageLimitPolicy;
  quota?: UsageLimitQuota;
  nowMs: number;
  locale?: string;
}) {
  const { t } = useTranslation();
  const markersFor = useUsageLimitMarkers(policy, nowMs);
  const windows = quota?.status === 'success' ? (quota.windows ?? []) : [];
  const pacedWindow = pickPacedWindow(policy.provider, windows);
  const pace = pacedWindow ? computeDailyPace(pacedWindow, policy, nowMs) : null;
  const reserveHits = windows.filter((window) => isReserveReached(window, policy));
  const windowLabel = (window: (typeof windows)[number]) =>
    window.labelKey ? t(window.labelKey, window.labelParams ?? {}) : window.label;

  const lines: { key: string; text: string; warn?: boolean }[] = [];
  if (!isUsageLimitActive(policy)) {
    lines.push({ key: 'inactive', text: t('quota_management.usage_limits.preview_inactive') });
  }
  if (policy.reservePercent > 0) {
    lines.push({
      key: 'reserve',
      text: t('quota_management.usage_limits.preview_keeps_free', {
        value: formatLimitPercent(policy.reservePercent),
      }),
    });
  }
  reserveHits.forEach((window) => {
    lines.push({
      key: `reserve-hit-${window.id}`,
      warn: true,
      text: t('quota_management.usage_limits.preview_reserve_reached', {
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
        text: t('quota_management.usage_limits.preview_today', {
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
          text: t('quota_management.usage_limits.preview_pace_reached', {
            time: nextDay.relative ?? nextDay.absolute,
          }),
        });
      }
      lines.push({
        key: 'pace-share',
        text: t('quota_management.usage_limits.preview_daily_share', {
          share: formatLimitPercent(pace.dailySharePercent),
        }),
      });
    } else {
      lines.push({
        key: 'pace-missing',
        text: t('quota_management.usage_limits.preview_no_window'),
      });
    }
  }

  const meterWindow =
    pacedWindow ?? windows.find((window) => isUsageLimitWindow(policy.provider, window.id)) ?? null;
  const remaining =
    meterWindow?.usedPercent == null ? null : clampPercent(100 - meterWindow.usedPercent);
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
        <span className={styles.sectionTitle}>
          {t('quota_management.usage_limits.preview_title')}
        </span>
        {meterWindow && (
          <span className={styles.previewWindow}>
            {windowLabel(meterWindow)}
            {remaining !== null && (
              <span className={styles.previewPercent}>
                {t('quota_management.usage_limits.preview_remaining', {
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
