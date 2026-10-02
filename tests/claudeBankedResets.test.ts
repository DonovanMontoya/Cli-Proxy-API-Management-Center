import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type { TFunction } from 'i18next';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '@/i18n';
import { QuotaRowCells } from '@/features/quota/components/QuotaRowCells';
import { CLAUDE_CONFIG, summarizeClaudeBankedResets } from '@/features/quota/providers/claude/data';
import { collectQuotaRowInstants } from '@/features/quota/resetSchedule';
import { buildTimelineLane } from '@/features/quota/quotaTimelineModel';
import { apiCallApi, type ApiCallRequest, type ApiCallResult } from '@/services/api';
import { parseAnthropicResetGrantStatus } from '@/services/api/claudeResetGrants';
import type { AuthFileItem, ClaudeQuotaState } from '@/types';

const NOW = Date.parse('2026-10-02T12:00:00Z');
const STARTS_AT = '2026-09-22T16:00:00+00:00';
const ENDS_AT = '2026-10-22T16:00:00+00:00';
const GRANT_ID = 'opus55-launch-promax-20260921';

const grant = (overrides: Record<string, unknown> = {}) => ({
  id: GRANT_ID,
  label: 'Claude Opus 5.5 launch: one usage-limit reset',
  resets_total: 1,
  resets_left: 1,
  starts_at: STARTS_AT,
  ends_at: ENDS_AT,
  clears: ['five_hour', 'seven_day'],
  paused: false,
  usable_now: true,
  ...overrides,
});

const block = (overrides: Record<string, unknown> = {}) => ({
  eligible: true,
  at_limit: true,
  grants: [grant()],
  next_grant_id: GRANT_ID,
  ...overrides,
});

const summarize = (cedarEmber: unknown) =>
  summarizeClaudeBankedResets(parseAnthropicResetGrantStatus(cedarEmber), NOW);

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

describe('Claude banked resets', () => {
  const none = { rateLimitResetCreditsAvailableCount: null, rateLimitResetCredits: [] };

  test('reads an unspent grant with its expiry', () => {
    expect(summarize(block())).toEqual({
      rateLimitResetCreditsAvailableCount: 1,
      rateLimitResetCredits: [
        {
          id: GRANT_ID,
          status: 'available',
          grantedAt: STARTS_AT,
          expiresAt: ENDS_AT,
          resetsLeft: 1,
        },
      ],
    });
  });

  test('reports nothing when the block is absent, ineligible or holds no grant', () => {
    expect(summarize(undefined)).toEqual(none);
    expect(summarize({ eligible: false, ineligible_reason: 'surface' })).toEqual(none);
    expect(summarize(block({ grants: [] }))).toEqual(none);
  });

  test('shows zero once the only grant is spent', () => {
    expect(summarize(block({ grants: [grant({ resets_left: 0 })] }))).toEqual({
      rateLimitResetCreditsAvailableCount: 0,
      rateLimitResetCredits: [],
    });
  });

  test('does not count paused or expired grants', () => {
    const summary = summarize(
      block({
        grants: [
          grant({ id: 'paused', paused: true }),
          grant({ id: 'expired', ends_at: '2026-10-01T00:00:00Z' }),
          grant({ id: 'live', resets_total: 2, resets_left: 2 }),
        ],
        next_grant_id: 'live',
      })
    );
    expect(summary.rateLimitResetCreditsAvailableCount).toBe(2);
    expect(summary.rateLimitResetCredits.map((credit) => credit.id)).toEqual(['live']);
  });

  test('keeps a banked reset that cannot be spent right now', () => {
    const summary = summarize(block({ at_limit: false, grants: [grant({ usable_now: false })] }));
    expect(summary.rateLimitResetCreditsAvailableCount).toBe(1);
  });

  const state: ClaudeQuotaState = {
    status: 'success',
    windows: [{ id: 'five-hour', label: '5-hour limit', usedPercent: 30, resetLabel: '' }],
    rateLimitResetCreditsAvailableCount: 1,
    rateLimitResetCredits: [
      {
        id: GRANT_ID,
        status: 'available',
        grantedAt: STARTS_AT,
        expiresAt: new Date(Date.now() + 12 * 24 * 60 * 60 * 1000 + 60 * 60 * 1000).toISOString(),
        resetsLeft: 1,
      },
    ],
  };

  test('shows banked resets beside Claude usage', () => {
    const markup = renderToStaticMarkup(
      createElement(QuotaRowCells, { type: 'claude', quota: state })
    );
    expect(markup).toContain('Banked resets');
    expect(markup).toContain('<strong>1</strong> available');
    expect(markup).toContain('Reset 1');
    expect(markup).toContain('12 days');
  });

  test('shows no reset cell for an account without a grant', () => {
    const markup = renderToStaticMarkup(
      createElement(QuotaRowCells, {
        type: 'claude',
        quota: { ...state, rateLimitResetCreditsAvailableCount: null, rateLimitResetCredits: [] },
      })
    );
    expect(markup).not.toContain('Banked resets');
  });

  test('feeds the expiry into the reset schedule and the timeline', () => {
    const expiresAtMs = Date.parse(state.rateLimitResetCredits?.[0].expiresAt ?? '');
    expect(collectQuotaRowInstants('claude', state)).toEqual([
      { rowId: GRANT_ID, atMs: expiresAtMs, kind: 'credit' },
    ]);

    const lane = buildTimelineLane({
      name: 'claude.json',
      displayName: 'claude',
      provider: 'claude',
      quota: {
        ...state,
        windows: [{ ...state.windows[0], resetAtMs: Date.now() + 60 * 60 * 1000, periodHours: 5 }],
      },
    });
    expect(lane.resetCredits).toEqual([
      { id: GRANT_ID, grantedAtMs: Date.parse(STARTS_AT), expiresAtMs },
    ]);
  });
});

describe('Claude banked reset spend', () => {
  const t = ((key: string) => key) as TFunction;
  const ORG = '11111111-2222-4333-8444-555555555555';
  const RESET_URL = `https://api.anthropic.com/api/organizations/${ORG}/reset_rate_limits`;
  const originalRequest = apiCallApi.request;
  const reply = (statusCode: number, body: unknown): ApiCallResult => ({
    statusCode,
    header: {},
    bodyText: JSON.stringify(body),
    body,
  });

  afterEach(() => {
    apiCallApi.request = originalRequest;
  });

  // Every request is answered in-process; nothing here reaches the network.
  const mockApi = (
    authIndex: string,
    cedarEmber: unknown,
    spend: () => ApiCallResult = () => reply(200, { result: 'reset', resets_left: 0 })
  ) => {
    const requests: ApiCallRequest[] = [];
    apiCallApi.request = (async (request: ApiCallRequest) => {
      requests.push(request);
      if (request.method === 'POST') return spend();
      if (request.url.includes('/oauth/profile')) {
        return reply(200, { organization: { uuid: ORG }, account: { has_claude_max: true } });
      }
      return reply(200, {
        five_hour: { utilization: 100, resets_at: ENDS_AT },
        cedar_ember: cedarEmber,
      });
    }) as typeof apiCallApi.request;
    return {
      file: { name: `${authIndex}.json`, provider: 'claude', authIndex } as AuthFileItem,
      posts: () => requests.filter((request) => request.method === 'POST'),
      requests,
    };
  };

  const liveBlock = () => block({ grants: [grant({ ends_at: '2999-01-01T00:00:00Z' })] });

  test('offers the reset only while a banked reset remains', () => {
    const quota: ClaudeQuotaState = { status: 'success', windows: [] };
    expect(CLAUDE_CONFIG.canResetQuota?.(quota)).toBeFalse();
    expect(
      CLAUDE_CONFIG.canResetQuota?.({ ...quota, rateLimitResetCreditsAvailableCount: 0 })
    ).toBeFalse();
    expect(
      CLAUDE_CONFIG.canResetQuota?.({ ...quota, rateLimitResetCreditsAvailableCount: 1 })
    ).toBeTrue();
  });

  test('loads banked resets with the usage request', async () => {
    const api = mockApi('load', liveBlock());
    const data = await CLAUDE_CONFIG.fetchQuota(api.file, t);

    expect(api.requests.map((request) => request.url)).toEqual([
      'https://api.anthropic.com/api/oauth/usage?cedar_ember=1',
      'https://api.anthropic.com/api/oauth/profile',
    ]);
    expect(api.posts()).toHaveLength(0);
    expect(data.rateLimitResetCreditsAvailableCount).toBe(1);
    expect(data.windows).toHaveLength(1);
  });

  test('spends the grant the server names, once, then reloads the quota', async () => {
    const api = mockApi('spend-ok', liveBlock());
    const data = await CLAUDE_CONFIG.resetQuota?.(api.file, t);

    expect(api.posts()).toHaveLength(1);
    const post = api.posts()[0];
    expect(post.url).toBe(RESET_URL);
    expect(post.authIndex).toBe('spend-ok');
    const body = JSON.parse(post.data ?? '{}');
    expect(body).toEqual({
      program: 'cedar_ember',
      grant_id: GRANT_ID,
      request_id: body.request_id,
    });
    expect(body.request_id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    // The quota is read again only after the claim was answered.
    expect(api.requests.at(-1)?.method).toBe('GET');
    expect(api.requests.indexOf(post)).toBeLessThan(api.requests.length - 2);
    expect(data?.windows).toHaveLength(1);
  });

  test('sends nothing when no grant is spendable right now', async () => {
    const notUsable = mockApi(
      'not-usable',
      block({ grants: [grant({ ends_at: '2999-01-01T00:00:00Z', usable_now: false })] })
    );
    await expect(CLAUDE_CONFIG.resetQuota?.(notUsable.file, t)).rejects.toThrow(
      'claude_reset.blocked'
    );
    expect(notUsable.posts()).toHaveLength(0);

    // A grant that needs a reached limit is not spent on an account below it.
    const notLimited = mockApi('not-at-limit', { ...liveBlock(), at_limit: false });
    await expect(CLAUDE_CONFIG.resetQuota?.(notLimited.file, t)).rejects.toThrow(
      'claude_reset.blocked'
    );
    expect(notLimited.posts()).toHaveLength(0);
  });

  test('does not report success when the server answers 200 without spending', async () => {
    const api = mockApi('not-limited', liveBlock(), () => reply(200, { result: 'not_limited' }));
    await expect(CLAUDE_CONFIG.resetQuota?.(api.file, t)).rejects.toThrow(
      'claude_reset.not_limited'
    );
    expect(api.posts()).toHaveLength(1);
  });

  test('retries an unanswered spend with the same request id', async () => {
    const api = mockApi('retry', liveBlock(), () => reply(502, { error: 'bad gateway' }));
    await expect(CLAUDE_CONFIG.resetQuota?.(api.file, t)).rejects.toThrow('claude_reset.unknown');
    await expect(CLAUDE_CONFIG.resetQuota?.(api.file, t)).rejects.toThrow('claude_reset.unknown');

    const ids = api.posts().map((post) => JSON.parse(post.data ?? '{}').request_id);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
  });
});
