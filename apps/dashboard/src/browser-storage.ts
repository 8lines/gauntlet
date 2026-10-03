import type { StorageLike } from "./recent-runs.ts";

/**
 * `localStorage` of the dashboard page or the widget panel iframe, guarded: storage may be blocked
 * (privacy settings, third-party iframes), in which case reads come back empty and writes are dropped.
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
