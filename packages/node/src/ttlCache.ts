/**
 * A cache that expires, used by every provider that fetches over the
 * network.
 *
 * The default TTL is **zero** — every read re-fetches. That's deliberate
 * and it's the whole point of the product: a `sec://` reference is a
 * stable name for a value that changes underneath it. A consumer holding
 * the reference is supposed to see a rotated secret without being
 * redeployed, and a cache with no expiry silently breaks exactly that.
 * Before this existed, a long-running process fetched once and held the
 * old value until restart.
 *
 * A non-zero TTL is a real tradeoff, not a mistake: every expansion is a
 * network round trip, so a busy caller may want to trade a bounded window
 * of staleness for latency and API-rate-limit headroom. `ttlMs: 30_000`
 * means "a rotation reaches me within 30 seconds" — usually fine, and it
 * should be a decision someone made rather than a default they inherited.
 */
export interface TtlCacheOptions {
  /** Milliseconds an entry stays fresh. `0` (default) disables caching
   * entirely - every `fetch` call goes to the source. */
  ttlMs?: number;
  /** Injected in tests so expiry doesn't require real waiting. */
  now?: () => number;
}

interface Entry<T> {
  value: Promise<T>;
  storedAt: number;
}

export class TtlCache<T> {
  /** Settled values, only populated when a TTL is configured. */
  private readonly entries = new Map<string, Entry<T>>();
  /** Requests currently in flight, tracked separately from `entries`
   * because coalescing and caching are different things: sharing an
   * unsettled request holds no value past the moment it resolves, so it
   * stays correct even with caching fully disabled. */
  private readonly inFlight = new Map<string, Promise<T>>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: TtlCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? 0;
    this.now = options.now ?? Date.now;
  }

  /**
   * Returns the cached value for `key` if it's still fresh, otherwise
   * calls `load` and caches that. In-flight promises are shared, so N
   * concurrent expansions of the same reference make one request rather
   * than N even when the TTL is zero - that's request coalescing, not
   * caching, and it doesn't hold a value past its use.
   *
   * A rejected load is evicted rather than remembered, so a transient
   * failure doesn't become a sticky one.
   */
  async fetch(key: string, load: () => Promise<T>): Promise<T> {
    // Always join an in-flight request, whatever the TTL.
    const pendingExisting = this.inFlight.get(key);
    if (pendingExisting) return pendingExisting;

    const cached = this.entries.get(key);
    if (cached && this.ttlMs > 0 && this.now() - cached.storedAt < this.ttlMs) {
      return cached.value;
    }

    const pending = load();
    this.inFlight.set(key, pending);

    try {
      const value = await pending;
      // Only retain past settlement when a TTL was actually asked for.
      if (this.ttlMs > 0) {
        this.entries.set(key, { value: Promise.resolve(value), storedAt: this.now() });
      }
      return value;
    } catch (err) {
      // Never remember a failure - a transient outage shouldn't become
      // a sticky one for the length of the TTL.
      this.entries.delete(key);
      throw err;
    } finally {
      this.inFlight.delete(key);
    }
  }

  /** Drops everything - used when a credential changes underneath the
   * cache and anything fetched with the old one is suspect. */
  clear(): void {
    this.entries.clear();
  }
}
