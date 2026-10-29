/** Small HTTP layer: timeouts, retries with backoff, in-memory TTL cache. */

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

type CacheEntry = { expires: number; value: unknown };
const cache = new Map<string, CacheEntry>();

export function clearHttpCache() {
  cache.clear();
}

export type FetchJsonOptions = {
  timeoutMs?: number;
  retries?: number;
  headers?: Record<string, string>;
  cacheTtlMs?: number;
  fetchImpl?: typeof fetch;
};

export async function fetchJson<T>(url: string, options: FetchJsonOptions = {}): Promise<T> {
  const {
    timeoutMs = 12_000,
    retries = 2,
    headers = {},
    cacheTtlMs = 5 * 60_000,
    fetchImpl = fetch,
  } = options;

  const cached = cache.get(url);
  if (cached && cached.expires > Date.now()) return cached.value as T;

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          'User-Agent': 'Freehaven/0.1 (open-source learning app)',
          ...headers,
        },
      });
      if (!response.ok) {
        if (response.status >= 500 && attempt < retries) {
          lastError = new HttpError(`Server error (${response.status})`, response.status);
          await delay(300 * 2 ** attempt);
          continue;
        }
        throw new HttpError(`Request failed (${response.status})`, response.status);
      }
      const value = (await response.json()) as T;
      cache.set(url, { expires: Date.now() + cacheTtlMs, value });
      return value;
    } catch (error) {
      lastError = error;
      if (attempt >= retries) break;
      await delay(300 * 2 ** attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  if (lastError instanceof HttpError) throw lastError;
  if ((lastError as Error)?.name === 'AbortError') {
    throw new HttpError('The request timed out. Check your connection and try again.');
  }
  throw new HttpError((lastError as Error)?.message ?? 'Network request failed.');
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
