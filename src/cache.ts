/**
 * A process-lifetime response cache with in-flight coalescing.
 *
 * The key this server holds is allowed 10 requests a minute, and one
 * `compare_corridor` across ten countries can spend the whole minute inside a
 * single tool call. Two habits waste that budget:
 *
 *   1. Asking for the identical URL more than once inside one call. `convert`
 *      with a country does it twice for a direct pair and up to six times on a
 *      cross-USD route, because the country form returns every pair and we
 *      filter locally — so "direct" and "inverse" are the same request.
 *   2. Re-asking between calls for data upstream itself marks
 *      `cache-control: s-maxage=60`.
 *
 * Caching by URL fixes (2). Coalescing fixes (1) even when the duplicates are
 * concurrent, which the cache alone cannot: ten parallel requests all miss.
 *
 * Only public upstream responses live here, never anything caller-specific, so
 * sharing the cache across requests does not leak one caller's traffic into
 * another's answer. The stateless MCP transport still gets a fresh server and
 * session per request.
 */

interface Entry {
  value: unknown;
  expiresAt: number;
}

export interface CacheStats {
  hits: number;
  misses: number;
  coalesced: number;
  entries: number;
}

/** Bounded so a caller asking for endless base/quote combinations cannot grow it without limit. */
const MAX_ENTRIES = 500;

export class ResponseCache {
  private readonly entries = new Map<string, Entry>();
  private readonly inflight = new Map<string, Promise<unknown>>();
  private hits = 0;
  private misses = 0;
  private coalesced = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Return the cached value for `key`, join a request already in flight for it,
   * or run `load` and remember the result for `ttlMs`.
   *
   * Failures are never cached: a 429 or a dead upstream must not be served for
   * a minute to everyone who asks next.
   */
  async fetch<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    if (ttlMs > 0) {
      const hit = this.entries.get(key);
      if (hit && hit.expiresAt > this.now()) {
        this.hits += 1;
        return hit.value as T;
      }
      if (hit) this.entries.delete(key);
    }

    const pending = this.inflight.get(key);
    if (pending) {
      this.coalesced += 1;
      return pending as Promise<T>;
    }

    this.misses += 1;
    const promise = load()
      .then((value) => {
        if (ttlMs > 0) this.store(key, value, ttlMs);
        return value;
      })
      .finally(() => {
        this.inflight.delete(key);
      });

    this.inflight.set(key, promise);
    return promise;
  }

  private store(key: string, value: unknown, ttlMs: number): void {
    this.entries.set(key, { value, expiresAt: this.now() + ttlMs });
    if (this.entries.size <= MAX_ENTRIES) return;

    for (const [k, entry] of this.entries) {
      if (entry.expiresAt <= this.now()) this.entries.delete(k);
    }
    // Still over: drop oldest-inserted first. Map preserves insertion order.
    while (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  stats(): CacheStats {
    return { hits: this.hits, misses: this.misses, coalesced: this.coalesced, entries: this.entries.size };
  }

  clear(): void {
    this.entries.clear();
  }
}
