import type { QuotaProviderType } from './providers/types';

/** Tab order; the 'All' tab groups credential rows in this order too. */
export const QUOTA_TAB_ORDER: readonly QuotaProviderType[] = [
  'claude',
  'antigravity',
  'codex',
  'xai',
  'kimi',
  'devin',
  'meta',
];

export type QuotaTabId = 'all' | QuotaProviderType;

/** 20 per page, which also caps "refresh all" upstream concurrency at 20. */
export const QUOTA_PAGE_SIZE = 20;

/** Row order: default = grouped by provider; soonest = soonest recovery first. */
export const QUOTA_SORT_MODES = ['default', 'soonest'] as const;

export type QuotaSortMode = (typeof QUOTA_SORT_MODES)[number];
