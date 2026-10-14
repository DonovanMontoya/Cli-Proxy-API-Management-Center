import { describe, expect, it } from 'bun:test';
import { estimateClaudeRenewalMs } from '@/features/quota/providers/claude/data';

const profile = (created: string, status = 'active') => ({
  organization: { subscription_created_at: created, subscription_status: status },
});

describe('estimateClaudeRenewalMs', () => {
  it('returns the next monthly anniversary after now', () => {
    const now = Date.parse('2026-10-14T12:00:00Z');
    expect(estimateClaudeRenewalMs(profile('2025-03-20T08:00:00Z'), 'plan_max', now)).toBe(
      Date.parse('2026-10-20T08:00:00Z')
    );
    expect(estimateClaudeRenewalMs(profile('2025-03-02T08:00:00Z'), 'plan_max', now)).toBe(
      Date.parse('2026-11-02T08:00:00Z')
    );
  });

  it('clamps the day to the month length', () => {
    const now = Date.parse('2027-02-10T00:00:00Z');
    expect(estimateClaudeRenewalMs(profile('2026-01-31T00:00:00Z'), 'plan_pro', now)).toBe(
      Date.parse('2027-02-28T00:00:00Z')
    );
  });

  it('skips free, inactive or undated accounts', () => {
    const now = Date.now();
    expect(estimateClaudeRenewalMs(profile('2025-01-01T00:00:00Z'), 'plan_free', now)).toBeNull();
    expect(
      estimateClaudeRenewalMs(profile('2025-01-01T00:00:00Z', 'canceled'), 'plan_max', now)
    ).toBeNull();
    expect(estimateClaudeRenewalMs(profile(''), 'plan_max', now)).toBeNull();
    expect(estimateClaudeRenewalMs(null, 'plan_max', now)).toBeNull();
  });
});
