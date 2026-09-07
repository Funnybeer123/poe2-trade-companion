export interface MemoizeAsyncOptions {
  /** How long a settled result is served without calling `fetch` again. */
  ttlMs: number;
  /** Clock, injectable for tests. Defaults to `Date.now`. */
  now?: () => number;
}

export interface MemoizedAsync<T> {
  (): Promise<T>;
  /** Drop the cached value so the next call fetches again. */
  reset(): void;
}

/**
 * Wraps an async fetch so that a fresh result (younger than `ttlMs`, measured
 * from when it settled) is returned as-is and concurrent callers share one
 * in-flight promise instead of each starting their own. Rejections are
 * propagated to every waiting caller and never cached.
 */
export function memoizeAsync<T>(
  fetch: () => Promise<T>,
  options: MemoizeAsyncOptions,
): MemoizedAsync<T> {
  const now = options.now ?? Date.now;
  let cached: { result: T; at: number } | undefined;
  let inFlight: Promise<T> | undefined;

  const get = (() => {
    if (cached && now() - cached.at < options.ttlMs) return Promise.resolve(cached.result);
    if (inFlight) return inFlight;
    const started = (async () => {
      try {
        const result = await fetch();
        cached = { result, at: now() };
        return result;
      } finally {
        inFlight = undefined;
      }
    })();
    inFlight = started;
    return started;
  }) as MemoizedAsync<T>;
  get.reset = () => {
    cached = undefined;
  };
  return get;
}
