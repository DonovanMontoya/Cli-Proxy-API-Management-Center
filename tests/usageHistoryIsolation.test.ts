import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import {
  getUsageHistorySession,
  historyKey,
  readUsageHistory,
  resetUsageHistorySession,
  writeUsageHistory,
} from '@/features/quota/usageHistory';
import { useQuotaStore } from '@/stores/useQuotaStore';
import { useAuthStore } from '@/stores/useAuthStore';
import { useConfigStore } from '@/stores/useConfigStore';

const storage = () => {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
    clear: () => data.clear(),
    key: (index: number) => [...data.keys()][index] ?? null,
    get length() {
      return data.size;
    },
  };
};
const originalFetchConfig = useConfigStore.getState().fetchConfig;
const originalLocal = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const originalSession = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
const restoreProperty = (name: string, descriptor: PropertyDescriptor | undefined) => {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor);
  else Reflect.deleteProperty(globalThis, name);
};
const key = historyKey('codex', 'shared.json', 168);
const history = {
  [key]: [
    { t: 1800000000000, used: 10 },
    { t: 1800036000000, used: 60 },
  ],
};
const legacyKey = 'cpamc.quotaUsageHistory.v1';
const currentKey = 'cpamc.quotaUsageHistory.v2';

beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage() });
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: storage() });
  useQuotaStore.getState().clearQuotaCache();
});
afterEach(() => {
  useConfigStore.setState({ fetchConfig: originalFetchConfig });
  useAuthStore.getState().logout();
  restoreProperty('localStorage', originalLocal);
  restoreProperty('sessionStorage', originalSession);
});

describe('forecast history isolation', () => {
  test('initializes and resets on plain HTTP where randomUUID is unavailable', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis.crypto, 'randomUUID');
    Object.defineProperty(globalThis.crypto, 'randomUUID', {
      configurable: true,
      value: undefined,
    });
    try {
      const isolatedPath = '../src/features/quota/usageHistory.ts?plain-http';
      const isolated = await import(isolatedPath);
      const first = isolated.getUsageHistorySession();
      expect(first).toMatch(/^[a-f0-9]{32}$/);
      expect(isolated.resetUsageHistorySession()).not.toBe(first);
      const previous = getUsageHistorySession();
      useQuotaStore.getState().clearQuotaCache();
      expect(getUsageHistorySession()).not.toBe(previous);
    } finally {
      if (descriptor) Object.defineProperty(globalThis.crypto, 'randomUUID', descriptor);
      else Reflect.deleteProperty(globalThis.crypto, 'randomUUID');
    }
  });
  test('retains readings on route remounts in the same session', () => {
    const session = getUsageHistorySession();
    writeUsageHistory(session, history);
    expect(readUsageHistory(session)).toEqual(history);
    expect(readUsageHistory(session)).toEqual(history);
    expect(localStorage.getItem(currentKey)).toBeNull();
  });

  test('backend A to B to A and management account changes each start fresh', async () => {
    const fetch = spyOn(useConfigStore.getState(), 'fetchConfig').mockResolvedValue({});
    try {
      const sessions = new Set<string>();
      for (const [apiBase, managementKey] of [
        ['https://backend-a.invalid', 'fixture-account-a'],
        ['https://backend-b.invalid', 'fixture-account-a'],
        ['https://backend-a.invalid', 'fixture-account-a'],
        ['https://backend-a.invalid', 'fixture-account-b'],
      ]) {
        const old = useQuotaStore.getState().historySessionId;
        writeUsageHistory(old, history);
        await useAuthStore.getState().login({ apiBase, managementKey, rememberPassword: false });
        const session = useQuotaStore.getState().historySessionId;
        expect(session).not.toBe(old);
        expect(readUsageHistory(session)).toEqual({});
        writeUsageHistory(old, history); // A retired chart cannot publish to the new scope.
        expect(readUsageHistory(session)).toEqual({});
        writeUsageHistory(session, history);
        const persisted = sessionStorage.getItem(currentKey)!;
        expect(persisted).not.toContain(apiBase);
        expect(persisted).not.toContain(managementKey);
        sessions.add(session);
      }
      expect(sessions.size).toBe(4);
    } finally {
      fetch.mockRestore();
    }
  });

  test('logout purges history and blocks old-session reads and writes', () => {
    const old = getUsageHistorySession();
    writeUsageHistory(old, history);
    useAuthStore.getState().logout();
    expect(sessionStorage.getItem(currentKey)).toBeNull();
    expect(readUsageHistory(old)).toEqual({});
    writeUsageHistory(old, history);
    expect(readUsageHistory(getUsageHistorySession())).toEqual({});
  });

  test('failed login also retires the previous session', async () => {
    const old = getUsageHistorySession();
    writeUsageHistory(old, history);
    const fetch = spyOn(useConfigStore.getState(), 'fetchConfig').mockRejectedValue(
      new Error('offline')
    );
    try {
      await expect(
        useAuthStore.getState().login({
          apiBase: 'https://offline.invalid',
          managementKey: 'fixture-key',
        })
      ).rejects.toThrow('offline');
      expect(readUsageHistory(getUsageHistorySession())).toEqual({});
      expect(readUsageHistory(old)).toEqual({});
    } finally {
      fetch.mockRestore();
    }
  });

  test('discards ambiguous v1 data and mismatched sessions instead of migrating it', () => {
    localStorage.setItem(legacyKey, JSON.stringify(history));
    sessionStorage.setItem(currentKey, JSON.stringify({ session: 'another-tab', history }));
    expect(readUsageHistory(getUsageHistorySession())).toEqual({});
    expect(localStorage.getItem(legacyKey)).toBeNull();
  });

  test('credential mutation removes all Devin identities for that file and preserves other history', () => {
    const first = historyKey('devin', 'shared.json\0one', 168);
    const second = historyKey('devin', 'shared.json\0two', 168);
    const other = historyKey('claude', 'other.json', 168);
    writeUsageHistory(getUsageHistorySession(), {
      [first]: history[key],
      [second]: history[key],
      [other]: history[key],
    });
    const session = getUsageHistorySession();
    useQuotaStore.getState().clearQuotaCache(['shared.json']);
    expect(getUsageHistorySession()).toBe(session);
    expect(readUsageHistory(session)).toEqual({ [other]: history[key] });
    expect(useQuotaStore.getState().fileGenerations['shared.json']).toBe(1);
    expect(historyKey('devin', 'shared.json\0one', 168, 1)).not.toBe(first);
    expect(historyKey('claude', 'shared.json', 168)).not.toBe(key);
  });

  test('malformed data and unavailable storage do not crash or import old history', () => {
    sessionStorage.setItem(currentKey, '{broken');
    expect(readUsageHistory(getUsageHistorySession())).toEqual({});
    sessionStorage.setItem(
      currentKey,
      JSON.stringify({
        session: getUsageHistorySession(),
        history: {
          [key]: [
            { t: 10, used: 30 },
            { t: 'not-time', used: 20 },
            { t: 20, used: 101 },
          ],
          broken: {},
        },
      })
    );
    expect(readUsageHistory(getUsageHistorySession())).toEqual({ [key]: [{ t: 10, used: 30 }] });
    Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true,
      get() {
        throw new Error('blocked');
      },
    });
    const old = getUsageHistorySession();
    expect(() => writeUsageHistory(old, history)).not.toThrow();
    expect(readUsageHistory(old)).toEqual({});
    expect(resetUsageHistorySession()).not.toBe(old);
  });
});
