/**
 * App-wide privacy mode. One toggle masks emails on every page, so hiding
 * them in one place hides them everywhere.
 */

import { useCallback } from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { STORAGE_KEY_PRIVACY } from '@/utils/constants';
import { maskEmails, readLegacyPrivacyMode } from '@/utils/privacy';

interface PrivacyState {
  hideEmails: boolean;
  toggleHideEmails: () => void;
}

export const usePrivacyStore = create<PrivacyState>()(
  persist(
    (set) => ({
      hideEmails: readLegacyPrivacyMode(),
      toggleHideEmails: () => set((state) => ({ hideEmails: !state.hideEmails })),
    }),
    {
      name: STORAGE_KEY_PRIVACY,
      partialize: (state) => ({ hideEmails: state.hideEmails }),
    }
  )
);

/** Returns a formatter that masks emails while privacy mode is on and is a no-op otherwise. */
export const useMaskEmails = (): ((value: string) => string) => {
  const hideEmails = usePrivacyStore((state) => state.hideEmails);
  return useCallback((value: string) => (hideEmails ? maskEmails(value) : value), [hideEmails]);
};
