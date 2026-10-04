export interface LoginRateLimiter {
  /** Seconds until the first blocked key frees up, or undefined when no key is blocked. */
  blocked(keys: readonly string[], now: Date): number | undefined;
  fail(keys: readonly string[], now: Date): void;
  reset(keys: readonly string[]): void;
}

interface Window {
  count: number;
  readonly resetAt: number;
}

/** Fixed-window failure counter held in memory; restarts forget it, which is acceptable. */
export function createLoginRateLimiter(options: {
  readonly limit: number;
  readonly windowMs: number;
  readonly maxKeys: number;
}): LoginRateLimiter {
  const windows = new Map<string, Window>();

  function current(key: string, now: number): Window | undefined {
    const window = windows.get(key);
    if (window !== undefined && window.resetAt <= now) {
      windows.delete(key);
      return undefined;
    }
    return window;
  }

  return {
    blocked(keys, now) {
      let retryAfterMs: number | undefined;
      for (const key of keys) {
        const window = current(key, now.getTime());
        if (window !== undefined && window.count >= options.limit) {
          retryAfterMs = Math.max(retryAfterMs ?? 0, window.resetAt - now.getTime());
        }
      }
      return retryAfterMs === undefined ? undefined : Math.max(1, Math.ceil(retryAfterMs / 1000));
    },

    fail(keys, now) {
      for (const key of keys) {
        const window = current(key, now.getTime());
        if (window !== undefined) {
          window.count += 1;
          continue;
        }
        while (windows.size >= options.maxKeys) {
          const oldest = windows.keys().next();
          if (oldest.done === true) break;
          windows.delete(oldest.value);
        }
        windows.set(key, { count: 1, resetAt: now.getTime() + options.windowMs });
      }
    },

    reset(keys) {
      for (const key of keys) windows.delete(key);
    },
  };
}
