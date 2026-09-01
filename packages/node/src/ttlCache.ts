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
  /**
   * Milliseconds a *previously successful* value may be served after a
   * failed refresh. `0` (default) means a failure is a failure.
   *
   * This exists for one narrow case: use-time resolution couples every
   * use to the vault being reachable right now, so a two-second network
   * blip can fail a request that would otherwise have been fine. A short
   * grace window rides that out.
   *
   * It is emphatically not a general fallback, and `isStaleServable`
   * below is what keeps it honest. Serving a stale value over an expired
   * credential hides a change the operator has to act on; serving one
   * over a rotation means continuing to use a key that may have been
   * rotated *because it leaked*. Keep the window short.
   */
  staleGraceMs?: number;
  /**
   * Decides whether a given failure may be answered from the stale
   * value. Defaults to "never". Providers pass a predicate that admits
   * only transient faults - the cache itself stays free of any knowledge
   * about provider error taxonomies.
   */
  isStaleServable?: (err: unknown) => boolean;
  /** Called when a stale value is served, so the layer above can warn.
   * Never receives the value - only the key and its age. */
  onStale?: (key: string, ageMs: number, err: unknown) => void;
  /** Injected in tests so expiry doesn't require real waiting. */
  now?: () => number;
}

interface Entry<T> {
  value: Promise<T>;
  storedAt: number;
}

/** Thrown value carried alongside the stale answer, so a caller that
 * wants to know it got a stale value can, without the cache having to
 * invent a wrapper type for the success path. */
export interface StaleServeInfo {
  key: string;
  ageMs: number;
  error: unknown;
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
  private readonly staleGraceMs: number;
  private readonly isStaleServable: (err: unknown) => boolean;
  private readonly onStale?: (key: string, ageMs: number, err: unknown) => void;
  private readonly now: () => number;

  constructor(options: TtlCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? 0;
    this.staleGraceMs = options.staleGraceMs ?? 0;
    this.isStaleServable = options.isStaleServable ?? (() => false);
    this.onStale = options.onStale;
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
      // Retain past settlement when a TTL was asked for, or when a stale
      // grace window was - the latter needs a previous value to fall back
      // on, but never serves it as fresh (the freshness check above still
      // requires ttlMs > 0).
      if (this.ttlMs > 0 || this.staleGraceMs > 0) {
        this.entries.set(key, { value: Promise.resolve(value), storedAt: this.now() });
      }
      return value;
    } catch (err) {
      const previous = this.entries.get(key);
      if (previous && this.staleGraceMs > 0 && this.isStaleServable(err)) {
        const ageMs = this.now() - previous.storedAt;
        if (ageMs <= this.staleGraceMs) {
          // Deliberately does NOT refresh storedAt: the grace window runs
          // from the last *successful* fetch, so a provider that stays
          // down cannot be ridden indefinitely one failure at a time.
          this.onStale?.(key, ageMs, err);
          return previous.value;
        }
      }
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
