/**
 * In-process failed-sign-in limits (mirrors LifeOS Portal's per-account throttle).
 * Counts reset per process; with several API instances each enforces its own window.
 */
export function createFailureThrottle(opts: { limit: number; windowMs: number; maxKeys?: number }) {
  const failures = new Map<string, { count: number; firstAt: number }>();
  const maxKeys = opts.maxKeys ?? 10_000;

  const current = (key: string) => {
    const entry = failures.get(key);
    if (entry && Date.now() - entry.firstAt > opts.windowMs) {
      failures.delete(key);
      return undefined;
    }
    return entry;
  };

  return {
    blocked: (key: string) => (current(key)?.count ?? 0) >= opts.limit,
    fail: (key: string) => {
      const entry = current(key);
      if (entry) {
        entry.count += 1;
        return;
      }
      if (failures.size >= maxKeys) failures.delete(failures.keys().next().value!);
      failures.set(key, { count: 1, firstAt: Date.now() });
    },
    clear: (key: string) => {
      failures.delete(key);
    },
    reset: () => failures.clear(),
  };
}
