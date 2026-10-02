/**
 * App-wide privacy mode. One toggle masks personal info on every page, so hiding
 * it in one place hides it everywhere.
 */

import { useCallback } from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { STORAGE_KEY_PRIVACY } from '@/utils/constants';
import { maskPii, readLegacyPrivacyMode } from '@/utils/privacy';

interface PrivacyState {
  hidePii: boolean;
  toggleHidePii: () => void;
}

export const usePrivacyStore = create<PrivacyState>()(
  persist(
    (set) => ({
      hidePii: readLegacyPrivacyMode(),
      toggleHidePii: () => set((state) => ({ hidePii: !state.hidePii })),
    }),
    {
      name: STORAGE_KEY_PRIVACY,
      version: 1,
      // v0 stored the flag as `hideEmails`.
      migrate: (persisted) => ({
        hidePii: (persisted as { hideEmails?: boolean } | undefined)?.hideEmails === true,
      }),
      partialize: (state) => ({ hidePii: state.hidePii }),
    }
  )
);

/** Returns a formatter that masks personal info while privacy mode is on and is a no-op otherwise. */
export const useMaskPii = (): ((value: string) => string) => {
  const hidePii = usePrivacyStore((state) => state.hidePii);
  return useCallback((value: string) => (hidePii ? maskPii(value) : value), [hidePii]);
};
