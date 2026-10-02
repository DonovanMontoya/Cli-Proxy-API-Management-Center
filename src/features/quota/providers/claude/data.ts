/**
 * Claude quota data layer: usage windows + plan + extra usage + banked resets.
 * React-free / SCSS-free — consumed directly by tests/claudeFableQuota.test.ts.
 */

import type { TFunction } from 'i18next';
import type {
  AuthFileItem,
  ClaudeExtraUsage,
  ClaudeProfileResponse,
  ClaudeRateLimitResetCredit,
  ClaudeQuotaState,
  ClaudeQuotaWindow,
  ClaudeUsagePayload,
} from '@/types';
import { apiCallApi, getApiCallErrorMessage } from '@/services/api';
import {
  parseAnthropicResetGrantStatus,
  readClaudeResetGrants,
  type AnthropicResetGrantStatus,
} from '@/services/api/claudeResetGrants';
import {
  CLAUDE_PROFILE_URL,
  CLAUDE_USAGE_URL,
  CLAUDE_REQUEST_HEADERS,
  CLAUDE_USAGE_WINDOW_KEYS,
  claudePeriodHours,
  normalizeNumberValue,
  normalizeStringValue,
  parseClaudeUsagePayload,
  formatQuotaResetTime,
  resolveResetMs,
  createStatusError,
  isClaudeFile,
  isDisabledAuthFile,
} from '@/utils/quota';
import { normalizeAuthIndex } from '@/utils/authIndex';
import type { QuotaProviderData } from '../types';
import { resetGrantOperations } from './resetGrantOperations';
import { selectResetGrant } from './selectResetGrant';

export type ClaudeQuotaData = {
  windows: ClaudeQuotaWindow[];
  extraUsage?: ClaudeExtraUsage | null;
  planType?: string | null;
  rateLimitResetCreditsAvailableCount: number | null;
  rateLimitResetCredits: ClaudeRateLimitResetCredit[];
};

// The flag adds the banked-reset (`cedar_ember`) block to the usage payload and
// leaves the rest unchanged, so the resets ride along with the existing request.
const CLAUDE_USAGE_WITH_RESETS_URL = `${CLAUDE_USAGE_URL}?cedar_ember=1`;

/**
 * Banked resets as the quota views show them: grants that still hold a reset,
 * are not paused and have not expired. Whether one can be spent this minute is
 * decided separately, right before spending.
 */
export const summarizeClaudeBankedResets = (
  status: AnthropicResetGrantStatus | null,
  nowMs: number
): Pick<ClaudeQuotaData, 'rateLimitResetCreditsAvailableCount' | 'rateLimitResetCredits'> => {
  if (!status?.eligible || status.grants.length === 0) {
    return { rateLimitResetCreditsAvailableCount: null, rateLimitResetCredits: [] };
  }

  const credits = status.grants
    .filter(
      (grant) =>
        grant.resetsLeft > 0 &&
        !grant.paused &&
        !(grant.endsAt && Date.parse(grant.endsAt) <= nowMs)
    )
    .map((grant) => ({
      id: grant.id,
      status: 'available',
      grantedAt: grant.startsAt ?? '',
      expiresAt: grant.endsAt ?? '',
      resetsLeft: grant.resetsLeft,
    }));

  return {
    rateLimitResetCreditsAvailableCount: credits.reduce(
      (total, credit) => total + credit.resetsLeft,
      0
    ),
    rateLimitResetCredits: credits,
  };
};

const findFableUsageLimit = (payload: ClaudeUsagePayload) => {
  if (!Array.isArray(payload.limits)) return null;

  const candidates = payload.limits.filter((limit) => {
    const kind = (normalizeStringValue(limit?.kind) ?? '').trim().toLowerCase();
    const modelName = (normalizeStringValue(limit?.scope?.model?.display_name) ?? '')
      .trim()
      .toLowerCase();
    // Matches 'Fable', 'Fable 5', 'Fable 5.1', … but not other models.
    const isFable = /^fable(\s+\d+(\.\d+)?)?$/.test(modelName);
    return kind === 'weekly_scoped' && isFable && normalizeNumberValue(limit?.percent) !== null;
  });

  return candidates.find((limit) => limit.is_active === true) ?? candidates[0] ?? null;
};

export const buildClaudeQuotaWindows = (
  payload: ClaudeUsagePayload,
  t: TFunction
): ClaudeQuotaWindow[] => {
  const windows: ClaudeQuotaWindow[] = [];
  const fableLimit = findFableUsageLimit(payload);

  for (const { key, id, labelKey } of CLAUDE_USAGE_WINDOW_KEYS) {
    if (key === 'iguana_necktie' && fableLimit) continue;
    const window = payload[key as keyof ClaudeUsagePayload];
    if (!window || typeof window !== 'object' || !('utilization' in window)) continue;
    const typedWindow = window as { utilization: number; resets_at: string | null };
    const usedPercent = normalizeNumberValue(typedWindow.utilization);
    const resetLabel = formatQuotaResetTime(typedWindow.resets_at ?? undefined);
    windows.push({
      id,
      label: t(labelKey),
      labelKey,
      usedPercent,
      resetLabel,
      // Claude states the period nowhere in the payload, so it comes from the
      // key: `five_hour` is the rolling window, everything else is weekly.
      resetAtMs: resolveResetMs([typedWindow.resets_at]),
      periodHours: claudePeriodHours(key),
    });
  }

  if (fableLimit) {
    const usedPercent = normalizeNumberValue(fableLimit.percent);
    if (usedPercent !== null) {
      windows.push({
        id: 'seven-day-fable',
        label: t('claude_quota.seven_day_fable'),
        labelKey: 'claude_quota.seven_day_fable',
        usedPercent,
        resetLabel: formatQuotaResetTime(fableLimit.resets_at ?? undefined),
        // `weekly_scoped` is a 7-day window by definition, so the timeline can
        // place this row alongside the ones derived from the named keys.
        resetAtMs: resolveResetMs([fableLimit.resets_at]),
        periodHours: claudePeriodHours('seven_day'),
      });
    }
  }

  return windows;
};

const normalizeFlagValue = (value: unknown): boolean | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const trimmed = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'y', 'on'].includes(trimmed)) return true;
    if (['false', '0', 'no', 'n', 'off'].includes(trimmed)) return false;
  }
  return undefined;
};

const parseClaudeProfilePayload = (payload: unknown): ClaudeProfileResponse | null => {
  if (payload === undefined || payload === null) return null;
  if (typeof payload === 'string') {
    const trimmed = payload.trim();
    if (!trimmed) return null;
    try {
      return JSON.parse(trimmed) as ClaudeProfileResponse;
    } catch {
      return null;
    }
  }
  if (typeof payload === 'object') {
    return payload as ClaudeProfileResponse;
  }
  return null;
};

export const resolveClaudePlanType = (profile: ClaudeProfileResponse | null): string | null => {
  if (!profile) return null;

  const organizationType = normalizeStringValue(
    profile.organization?.organization_type
  )?.toLowerCase();
  const subscriptionStatus = normalizeStringValue(
    profile.organization?.subscription_status
  )?.toLowerCase();

  if (organizationType === 'claude_team' && subscriptionStatus === 'active') {
    return 'plan_team';
  }

  // Account flags include personal subscriptions even for a Team-scoped token.
  const hasClaudeMax = normalizeFlagValue(profile.account?.has_claude_max);
  if (hasClaudeMax) return 'plan_max';

  const hasClaudePro = normalizeFlagValue(profile.account?.has_claude_pro);
  if (hasClaudePro) return 'plan_pro';

  if (hasClaudeMax === false && hasClaudePro === false) return 'plan_free';

  return null;
};

const fetchClaudeQuota = async (file: AuthFileItem, t: TFunction): Promise<ClaudeQuotaData> => {
  const rawAuthIndex = file['auth_index'] ?? file.authIndex;
  const authIndex = normalizeAuthIndex(rawAuthIndex);
  if (!authIndex) {
    throw new Error(t('claude_quota.missing_auth_index'));
  }

  const [usageResult, profileResult] = await Promise.allSettled([
    apiCallApi.request({
      authIndex,
      method: 'GET',
      url: CLAUDE_USAGE_WITH_RESETS_URL,
      header: { ...CLAUDE_REQUEST_HEADERS },
    }),
    apiCallApi.request({
      authIndex,
      method: 'GET',
      url: CLAUDE_PROFILE_URL,
      header: { ...CLAUDE_REQUEST_HEADERS },
    }),
  ]);

  if (usageResult.status === 'rejected') {
    throw usageResult.reason;
  }

  const result = usageResult.value;

  if (result.statusCode < 200 || result.statusCode >= 300) {
    throw createStatusError(getApiCallErrorMessage(result), result.statusCode);
  }

  const payload = parseClaudeUsagePayload(result.body ?? result.bodyText);
  if (!payload) {
    throw new Error(t('claude_quota.empty_windows'));
  }

  const windows = buildClaudeQuotaWindows(payload, t);
  const planType =
    profileResult.status === 'fulfilled' &&
    profileResult.value.statusCode >= 200 &&
    profileResult.value.statusCode < 300
      ? resolveClaudePlanType(
          parseClaudeProfilePayload(profileResult.value.body ?? profileResult.value.bodyText)
        )
      : null;

  return {
    windows,
    extraUsage: payload.extra_usage,
    planType,
    ...summarizeClaudeBankedResets(parseAnthropicResetGrantStatus(payload.cedar_ember), Date.now()),
  };
};

/**
 * Spends one banked reset through the shared reset-grant journal, which
 * re-checks eligibility, sends a single claim and keeps the request id for a
 * same-id retry when the outcome is unknown.
 */
const resetClaudeQuota = async (file: AuthFileItem, t: TFunction): Promise<ClaudeQuotaData> => {
  const authIndex = normalizeAuthIndex(file['auth_index'] ?? file.authIndex);
  if (!authIndex) {
    throw new Error(t('claude_quota.missing_auth_index'));
  }

  const key = JSON.stringify([file.name, authIndex]);
  const unresolvedGrantId = () => {
    const operation = resetGrantOperations.inspect(key);
    return operation && !operation.code ? operation.grantId : undefined;
  };

  let grantId = unresolvedGrantId();
  if (!grantId) {
    const status = await readClaudeResetGrants(authIndex).catch(() => {
      throw new Error(t('claude_reset.read_error'));
    });
    grantId = selectResetGrant(status, Date.now())?.id;
  }
  if (!grantId) {
    throw new Error(t('claude_reset.blocked'));
  }

  const answer = await resetGrantOperations.run(key, authIndex, grantId).catch(() => {
    throw new Error(t(unresolvedGrantId() ? 'claude_reset.unknown' : 'claude_reset.blocked'));
  });
  if (answer.unresolved) {
    throw new Error(t('claude_reset.unknown'));
  }
  // On a retry `already_used` means the earlier claim did spend the reset.
  if (answer.code !== 'reset' && answer.code !== 'already_used') {
    throw new Error(t(`claude_reset.${answer.code}`));
  }

  return fetchClaudeQuota(file, t);
};

export const CLAUDE_CONFIG: QuotaProviderData<ClaudeQuotaState, ClaudeQuotaData> = {
  type: 'claude',
  i18nPrefix: 'claude_quota',
  filterFn: (file) => isClaudeFile(file) && !isDisabledAuthFile(file),
  fetchQuota: fetchClaudeQuota,
  resetQuota: resetClaudeQuota,
  canResetQuota: (quota) => (quota.rateLimitResetCreditsAvailableCount ?? 0) > 0,
  storeSelector: (state) => state.claudeQuota,
  storeSetter: 'setClaudeQuota',
  buildLoadingState: () => ({ status: 'loading', windows: [] }),
  buildSuccessState: (data) => ({
    status: 'success',
    windows: data.windows,
    extraUsage: data.extraUsage,
    planType: data.planType,
    rateLimitResetCreditsAvailableCount: data.rateLimitResetCreditsAvailableCount,
    rateLimitResetCredits: data.rateLimitResetCredits,
  }),
  buildErrorState: (message, status) => ({
    status: 'error',
    windows: [],
    error: message,
    errorStatus: status,
  }),
};
