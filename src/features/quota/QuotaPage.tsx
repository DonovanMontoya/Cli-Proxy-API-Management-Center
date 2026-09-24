/**
 * Quota page: summary bar, provider tabs, and credential rows grouped by provider.
 *
 * Behavioural contracts kept through the redesign:
 * - visible credentials load on first visit; explicit refresh remains available;
 * - cacheGeneration session isolation + request-id dedup (see useQuotaBatchLoader);
 * - quota caches are pruned per provider when the file list changes (no stale deleted files);
 * - useHeaderRefresh single slot: this page is the only registrant, global refresh = refetch files.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { authFilesApi } from '@/services/api';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { IconEye, IconEyeOff, IconSearch, IconX } from '@/components/ui/icons';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { useNow } from '@/hooks/useNow';
import { useRevealGroup } from '@/hooks/motion';
import { useAuthStore, useQuotaStore, useThemeStore } from '@/stores';
import type { AuthFileItem, ResolvedTheme } from '@/types';
import { getQuotaCacheKey, getQuotaDisplayName } from '@/utils/quota/identity';
import { ProviderTabs } from '@/features/authFiles/components/ProviderTabs';
import { getTypeLabel } from '@/features/authFiles/constants';
import { QuotaHeader } from './components/QuotaHeader';
import { QuotaRow } from './components/QuotaRow';
import { QuotaSummary } from './components/QuotaSummary';
import { QuotaTimeline } from './components/QuotaTimeline';
import rowStyles from './components/QuotaRow.module.scss';
import {
  QUOTA_PAGE_SIZE,
  QUOTA_SORT_MODES,
  QUOTA_TAB_ORDER,
  type QuotaSortMode,
  type QuotaTabId,
} from './constants';
import {
  buildTabCounts,
  canRefreshQuotaAfterList,
  classifyQuotaFiles,
  filterEntriesByTab,
  filterEntriesBySearch,
  paginate,
  selectUnloadedQuotaEntries,
  sortQuotaEntries,
  type QuotaFileEntry,
} from './logic';
import { nextRecoveryMs } from './resetSchedule';
import { QUOTA_ADAPTERS, getQuotaSetter, type QuotaCardState } from './providers';
import type { QuotaProviderType } from './providers/types';
import { useQuotaActions } from './hooks/useQuotaActions';
import { useQuotaBatchLoader } from './hooks/useQuotaBatchLoader';
import { readQuotaUiState, writeQuotaUiState } from './uiState';
import { maskEmails, readPrivacyMode, writePrivacyMode } from './privacy';
import { restrictedModelsFor } from './modelAccess';
import { buildProviderSummaries } from './summaryModel';
import styles from './QuotaPage.module.scss';

const TAB_IDS: string[] = ['all', ...QUOTA_TAB_ORDER];
const SKELETON_ROW_COUNT = 3;

export function QuotaPage() {
  const { t } = useTranslation();
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const resolvedTheme: ResolvedTheme = useThemeStore((state) => state.resolvedTheme);

  const [files, setFiles] = useState<AuthFileItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<QuotaTabId>(() => readQuotaUiState()?.tab ?? 'all');
  const [sortMode, setSortMode] = useState<QuotaSortMode>(
    () => readQuotaUiState()?.sortMode ?? 'default'
  );
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [privacyMode, setPrivacyMode] = useState(readPrivacyMode);
  const togglePrivacyMode = useCallback(() => {
    setPrivacyMode((prev) => {
      writePrivacyMode(!prev);
      return !prev;
    });
  }, []);
  /** Rows and timeline lanes share one label; privacy mode masks emails in both. */
  const displayNameFor = useCallback(
    (name: string) => (privacyMode ? maskEmails(name) : name),
    [privacyMode]
  );
  const searchInputRef = useRef<HTMLInputElement>(null);
  // Header + tabs entrance cascade (title → meta → action → tabs, 70ms apart)
  const revealRef = useRevealGroup<HTMLDivElement>();

  const disableControls = connectionStatus !== 'connected';

  /* ---------- File list ---------- */

  const sessionGeneration = useQuotaStore((state) => state.cacheGeneration);
  const [filesGeneration, setFilesGeneration] = useState<number | null>(null);
  const listRequestRef = useRef(0);
  const loadFiles = useCallback(async () => {
    const requestId = ++listRequestRef.current;
    if (connectionStatus !== 'connected') {
      setFiles([]);
      setFilesGeneration(null);
      setLoading(false);
      return;
    }
    const isCurrent = () =>
      requestId === listRequestRef.current &&
      sessionGeneration === useQuotaStore.getState().cacheGeneration;
    setLoading(true);
    setError('');
    try {
      const data = await authFilesApi.list();
      if (!isCurrent()) return;
      setFiles(data?.files || []);
      setFilesGeneration(sessionGeneration);
    } catch (err: unknown) {
      if (!isCurrent()) return;
      const message = err instanceof Error ? err.message : t('notification.refresh_failed');
      setError(message);
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [connectionStatus, sessionGeneration, t]);

  useHeaderRefresh(loadFiles);

  useEffect(() => {
    void loadFiles();
    return () => {
      listRequestRef.current += 1;
    };
  }, [loadFiles]);

  /* ---------- Quota caches ----------
   * Read before classify/sort: "soonest recovery first" needs them for its sort key. */

  const antigravityQuota = useQuotaStore((state) => state.antigravityQuota);
  const claudeQuota = useQuotaStore((state) => state.claudeQuota);
  const codexQuota = useQuotaStore((state) => state.codexQuota);
  const devinQuota = useQuotaStore((state) => state.devinQuota);
  const kimiQuota = useQuotaStore((state) => state.kimiQuota);
  const metaQuota = useQuotaStore((state) => state.metaQuota);
  const xaiQuota = useQuotaStore((state) => state.xaiQuota);

  const quotaByType = useMemo<Record<QuotaProviderType, Record<string, QuotaCardState>>>(
    () =>
      ({
        antigravity: antigravityQuota,
        claude: claudeQuota,
        codex: codexQuota,
        devin: devinQuota,
        kimi: kimiQuota,
        meta: metaQuota,
        xai: xaiQuota,
      }) as unknown as Record<QuotaProviderType, Record<string, QuotaCardState>>,
    [antigravityQuota, claudeQuota, codexQuota, devinQuota, kimiQuota, metaQuota, xaiQuota]
  );

  const getQuota = useCallback(
    (entry: QuotaFileEntry): QuotaCardState | undefined =>
      quotaByType[entry.type][getQuotaCacheKey(entry.file)],
    [quotaByType]
  );

  /* ---------- Classify / filter / sort / paginate ---------- */

  // Only subscribe the sort to the minute clock in "soonest recovery" mode. Ungated,
  // pageItems would change identity every minute and spin the "refresh all"
  // loading-falling-edge effect below.
  const tick = useNow(sortMode !== 'default');
  const sortNow = sortMode === 'default' ? 0 : tick;
  // The summary's reset countdowns always need the minute clock.
  const clockNow = useNow();

  const entries = useMemo(() => classifyQuotaFiles(files), [files]);
  const tabCounts = useMemo(() => buildTabCounts(entries), [entries]);
  const summaries = useMemo(
    () => buildProviderSummaries(entries, getQuota, clockNow),
    [entries, getQuota, clockNow]
  );
  const restrictionCounts = useMemo(() => {
    const counts: Partial<Record<string, Record<string, number>>> = {};
    entries.forEach((entry) => {
      restrictedModelsFor(entry.type, getQuota(entry)).forEach(({ model }) => {
        const perType = (counts[entry.type] ??= {});
        perType[model] = (perType[model] ?? 0) + 1;
      });
    });
    return counts;
  }, [entries, getQuota]);
  const filteredEntries = useMemo(
    () => filterEntriesBySearch(filterEntriesByTab(entries, tab), search),
    [entries, tab, search]
  );
  const handleSearchChange = useCallback((value: string) => {
    setSearch(value);
    setPage(1);
  }, []);

  const resolveNextRecovery = useCallback(
    (entry: QuotaFileEntry) => nextRecoveryMs(entry.type, getQuota(entry), sortNow),
    [getQuota, sortNow]
  );
  // Sort before paginating, otherwise "soonest recovery" only holds within one page.
  const sortedEntries = useMemo(
    () => sortQuotaEntries(filteredEntries, sortMode, resolveNextRecovery),
    [filteredEntries, sortMode, resolveNextRecovery]
  );

  const { pageItems, currentPage, totalPages } = useMemo(
    () => paginate(sortedEntries, page, QUOTA_PAGE_SIZE),
    [sortedEntries, page]
  );

  const handleTabChange = useCallback((next: string) => {
    setTab(next as QuotaTabId);
    setPage(1);
    writeQuotaUiState({ tab: next as QuotaTabId });
  }, []);

  const handleSortModeChange = useCallback((next: string) => {
    setSortMode(next as QuotaSortMode);
    setPage(1);
    writeQuotaUiState({ sortMode: next as QuotaSortMode });
  }, []);

  const sortOptions = useMemo(
    () =>
      QUOTA_SORT_MODES.map((mode) => ({ value: mode, label: t(`quota_management.sort_${mode}`) })),
    [t]
  );

  const { loadedCount, attentionCount } = useMemo(() => {
    let loaded = 0;
    let attention = 0;
    entries.forEach((entry) => {
      const status = quotaByType[entry.type][getQuotaCacheKey(entry.file)]?.status;
      if (status === 'success') loaded += 1;
      else if (status === 'error') attention += 1;
    });
    return { loadedCount: loaded, attentionCount: attention };
  }, [entries, quotaByType]);

  // Prune: once the file list settles, keep only cache entries for credentials that still exist
  useEffect(() => {
    if (loading || error || filesGeneration !== sessionGeneration) return;
    const survivorsByType = new Map<QuotaProviderType, Set<string>>(
      QUOTA_TAB_ORDER.map((type) => [type, new Set<string>()])
    );
    entries.forEach((entry) => survivorsByType.get(entry.type)?.add(getQuotaCacheKey(entry.file)));

    QUOTA_TAB_ORDER.forEach((type) => {
      const survivors = survivorsByType.get(type) ?? new Set<string>();
      const setQuota = getQuotaSetter(QUOTA_ADAPTERS[type]);
      setQuota((prev) => {
        const staleKeys = Object.keys(prev).filter((name) => !survivors.has(name));
        if (staleKeys.length === 0) return prev;
        const next = { ...prev };
        staleKeys.forEach((name) => delete next[name]);
        return next;
      });
    });
  }, [entries, error, filesGeneration, loading, sessionGeneration]);

  /* ---------- Loading and actions ---------- */

  const { batchLoading, loadQuota } = useQuotaBatchLoader();
  const { resettingQuotaName, refreshQuota, resetQuota } = useQuotaActions(disableControls);

  // The file list arrives first. Fetch quotas for the visible page as soon as it
  // settles, and do the same when pagination or the active tab reveals new rows.
  useEffect(() => {
    if (
      loading ||
      batchLoading ||
      error ||
      disableControls ||
      filesGeneration !== sessionGeneration
    )
      return;
    const targets = selectUnloadedQuotaEntries(pageItems, (entry) => getQuota(entry)?.status);
    if (targets.length > 0) void loadQuota(targets);
  }, [
    batchLoading,
    disableControls,
    error,
    filesGeneration,
    getQuota,
    loading,
    loadQuota,
    pageItems,
    sessionGeneration,
  ]);

  const pendingRefreshRef = useRef<number | null>(null);
  const prevLoadingRef = useRef(loading);

  // Refresh all: refetch the file list, then batch-load the current page once it settles (loading falling edge)
  const handleRefreshAll = useCallback(() => {
    if (disableControls) return;
    pendingRefreshRef.current = sessionGeneration;
    void loadFiles();
  }, [disableControls, loadFiles, sessionGeneration]);

  useEffect(() => {
    const wasLoading = prevLoadingRef.current;
    prevLoadingRef.current = loading;

    const requestedSession = pendingRefreshRef.current;
    if (requestedSession === null) return;
    if (requestedSession !== sessionGeneration) {
      pendingRefreshRef.current = null;
      return;
    }
    if (loading || !wasLoading) return;

    pendingRefreshRef.current = null;
    if (
      canRefreshQuotaAfterList(
        requestedSession,
        sessionGeneration,
        filesGeneration,
        Boolean(error),
        disableControls
      )
    ) {
      void loadQuota(pageItems);
    }
  }, [disableControls, error, filesGeneration, loading, loadQuota, pageItems, sessionGeneration]);

  const canUseActions = !disableControls && !loading && filesGeneration === sessionGeneration;

  /* Default order is provider-grouped, so rows are split into one section per
   * provider; "soonest recovery" interleaves providers and stays a flat list. */
  const rowGroups = useMemo(() => {
    if (sortMode !== 'default') return [{ type: null, items: pageItems }];
    const groups: { type: QuotaProviderType | null; items: QuotaFileEntry[] }[] = [];
    pageItems.forEach((entry) => {
      const last = groups[groups.length - 1];
      if (last && last.type === entry.type) last.items.push(entry);
      else groups.push({ type: entry.type, items: [entry] });
    });
    return groups;
  }, [pageItems, sortMode]);

  /* ---------- Render ---------- */

  const isEmpty = !loading && filteredEntries.length === 0;

  return (
    <div className={styles.page} ref={revealRef}>
      <QuotaHeader
        totalCount={entries.length}
        loadedCount={loadedCount}
        attentionCount={attentionCount}
        refreshing={loading || batchLoading}
        disableControls={disableControls}
        onRefreshAll={handleRefreshAll}
      />

      <QuotaSummary
        summaries={summaries}
        restrictionCounts={restrictionCounts}
        resolvedTheme={resolvedTheme}
        nowMs={clockNow}
      />

      <section className={styles.workbench}>
        {/* Provider navigation and the search toolbar sit on separate rows so they don't compete for focus. */}
        <div className={styles.tabsRow} data-reveal>
          <ProviderTabs
            types={TAB_IDS}
            counts={tabCounts}
            active={tab}
            resolvedTheme={resolvedTheme}
            onChange={handleTabChange}
          />
        </div>

        <div className={styles.toolbar}>
          <div className={styles.search}>
            <IconSearch size={16} className={styles.searchIcon} aria-hidden="true" />
            <input
              ref={searchInputRef}
              className={styles.searchInput}
              type="search"
              value={search}
              onChange={(event) => handleSearchChange(event.target.value)}
              placeholder={t('quota_management.search_placeholder')}
              aria-label={t('quota_management.search_label')}
            />
            {search && (
              <button
                type="button"
                className={styles.clearSearch}
                aria-label={t('quota_management.search_clear')}
                title={t('quota_management.search_clear')}
                onClick={() => {
                  handleSearchChange('');
                  searchInputRef.current?.focus();
                }}
              >
                <IconX size={14} aria-hidden="true" />
              </button>
            )}
          </div>
          <div className={styles.sort}>
            <Select
              value={sortMode}
              options={sortOptions}
              onChange={handleSortModeChange}
              ariaLabel={t('quota_management.sort_label')}
              size="sm"
            />
          </div>
          <button
            type="button"
            className={styles.privacyToggle}
            onClick={togglePrivacyMode}
            aria-pressed={privacyMode}
            title={t('quota_management.privacy_hint')}
          >
            {privacyMode ? (
              <IconEyeOff size={15} aria-hidden="true" />
            ) : (
              <IconEye size={15} aria-hidden="true" />
            )}
            {privacyMode
              ? t('quota_management.privacy_show_emails')
              : t('quota_management.privacy_hide_emails')}
          </button>
        </div>

        {error && (
          <div className={styles.errorBanner} role="alert">
            {error}
          </div>
        )}

        {loading ? (
          <div className={styles.groups} aria-hidden="true">
            {Array.from({ length: SKELETON_ROW_COUNT }, (_, index) => (
              <Skeleton key={index} height={64} rounded={12} />
            ))}
          </div>
        ) : isEmpty ? (
          <EmptyState
            title={
              search.trim()
                ? t('quota_management.search_empty_title')
                : tab === 'all'
                  ? t('quota_management.empty_title')
                  : t(`${QUOTA_ADAPTERS[tab].i18nPrefix}.empty_title`)
            }
            description={
              search.trim()
                ? t('quota_management.search_empty_desc')
                : tab === 'all'
                  ? t('quota_management.empty_desc')
                  : t(`${QUOTA_ADAPTERS[tab].i18nPrefix}.empty_desc`)
            }
            action={
              search.trim() ? (
                <Button variant="secondary" size="sm" onClick={() => handleSearchChange('')}>
                  {t('quota_management.search_clear')}
                </Button>
              ) : tab === 'all' ? undefined : (
                <Button variant="secondary" size="sm" onClick={() => handleTabChange('all')}>
                  {t('auth_files.filter_all')}
                </Button>
              )
            }
          />
        ) : (
          <div className={styles.groups}>
            {rowGroups.map((group, groupIndex) => (
              <section key={group.type ?? `flat-${groupIndex}`} className={styles.group}>
                {group.type && (
                  <h2 className={styles.groupTitle}>
                    {getTypeLabel(t, group.type)}
                    <span className={styles.groupCount}>{tabCounts[group.type] ?? 0}</span>
                  </h2>
                )}
                <ul className={rowStyles.list}>
                  {group.items.map((entry) => (
                    <QuotaRow
                      key={`${entry.type}:${getQuotaCacheKey(entry.file)}`}
                      entry={entry}
                      quota={getQuota(entry)}
                      displayName={displayNameFor(getQuotaDisplayName(entry.file))}
                      restrictions={restrictedModelsFor(entry.type, getQuota(entry))}
                      resolvedTheme={resolvedTheme}
                      showProviderIcon={group.type === null}
                      canRefresh={canUseActions && !entry.file.disabled}
                      resetting={resettingQuotaName === getQuotaCacheKey(entry.file)}
                      onRefresh={() => void refreshQuota(entry.file, QUOTA_ADAPTERS[entry.type])}
                      onReset={() => resetQuota(entry.file, QUOTA_ADAPTERS[entry.type])}
                    />
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}

        {!loading && filteredEntries.length > QUOTA_PAGE_SIZE && (
          <div className={styles.pagination}>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setPage(Math.max(1, currentPage - 1))}
              disabled={currentPage <= 1}
            >
              {t('auth_files.pagination_prev')}
            </Button>
            <div className={styles.pageInfo}>
              {t('auth_files.pagination_info', {
                current: currentPage,
                total: totalPages,
                count: filteredEntries.length,
              })}
            </div>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setPage(Math.min(totalPages, currentPage + 1))}
              disabled={currentPage >= totalPages}
            >
              {t('auth_files.pagination_next')}
            </Button>
          </div>
        )}

        {/* The timeline only compares the current page, so many credentials can't produce unbounded lanes. */}
        <QuotaTimeline
          entries={pageItems}
          quotaFor={getQuota}
          displayNameFor={displayNameFor}
          resolvedTheme={resolvedTheme}
        />
      </section>
    </div>
  );
}
