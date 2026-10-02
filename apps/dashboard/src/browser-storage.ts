import type { StorageLike } from "./recent-runs.ts";

/**
 * `localStorage` of the panel iframe, guarded: third-party iframes may have storage blocked
 * (privacy settings), in which case reads come back empty and writes are dropped.
 */
export const browserStorage: StorageLike = {
  getItem(key) {
    try {
      return globalThis.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem(key, value) {
    try {
      globalThis.localStorage.setItem(key, value);
    } catch {
      // Blocked or full storage: the recent-runs list just won't persist.
    }
  },
};
