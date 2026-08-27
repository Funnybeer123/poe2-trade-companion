export const DEFAULT_OFFICIAL_USER_AGENT =
  "poe2-trade-companion/0.1.0 (contact: local-qa; +https://github.com/Funnybeer123/poe2-trade-companion)";

export interface RateLimitFetchOptions {
  fetchImpl?: typeof fetch;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface RateLimitFetchResult {
  ok: boolean;
  status: number;
  retryAfterMs?: number;
  body?: string;
  headers: Record<string, string>;
  error?: string;
}

function headerMap(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

export function parseRetryAfterMs(value: string | undefined, nowMs: number): number | undefined {
  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }
  const dateMs = Date.parse(value);
  if (Number.isFinite(dateMs)) {
    return Math.max(0, dateMs - nowMs);
  }
  return undefined;
}

/**
 * Single-attempt fetch that honors Retry-After on 429 and never retries.
 * Callers reuse cache instead of storming the endpoint.
 */
export async function rateLimitFetch(
  url: string,
  options: RateLimitFetchOptions = {},
): Promise<RateLimitFetchResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const headers: Record<string, string> = {
    accept: "application/json",
    "user-agent": DEFAULT_OFFICIAL_USER_AGENT,
    ...options.headers,
  };

  const controller = new AbortController();
  const timeout = options.timeoutMs ?? 8_000;
  const timer = setTimeout(() => {
    controller.abort();
  }, timeout);
  const onAbort = (): void => {
    controller.abort();
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers,
      signal: controller.signal,
    });
    const mapped = headerMap(response.headers);
    const body = await response.text();
    const retryAfterMs = parseRetryAfterMs(mapped["retry-after"], Date.now());
    return {
      ok: response.ok,
      status: response.status,
      retryAfterMs,
      body,
      headers: mapped,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "network-error";
    const aborted = options.signal?.aborted === true || message.toLowerCase().includes("abort");
    return {
      ok: false,
      status: 0,
      headers: {},
      error: aborted ? "timeout" : "offline",
    };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

export function isThrottleStatus(status: number): boolean {
  return status === 429;
}

export function isTransientStatus(status: number): boolean {
  return status === 0 || status >= 500;
}
