import { describe, expect, it, vi } from "vitest";
import { TtlCache } from "../src/ttlCache.js";

describe("TtlCache", () => {
  it("re-fetches every time by default - a value is never held past its use", async () => {
    const load = vi.fn(async () => "v");
    const cache = new TtlCache<string>();

    await cache.fetch("k", load);
    await cache.fetch("k", load);

    expect(load).toHaveBeenCalledTimes(2);
  });

  it("returns the new value when the source changes", async () => {
    const load = vi.fn().mockResolvedValueOnce("old").mockResolvedValueOnce("rotated");
    const cache = new TtlCache<string>();

    expect(await cache.fetch("k", load)).toBe("old");
    expect(await cache.fetch("k", load)).toBe("rotated");
  });

  it("coalesces concurrent calls into one load, even with caching off", async () => {
    let resolve: (v: string) => void = () => {};
    const load = vi.fn(() => new Promise<string>((r) => (resolve = r)));
    const cache = new TtlCache<string>();

    const a = cache.fetch("k", load);
    const b = cache.fetch("k", load);
    resolve("v");

    expect(await a).toBe("v");
    expect(await b).toBe("v");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("does not coalesce calls made after the first settles", async () => {
    const load = vi.fn(async () => "v");
    const cache = new TtlCache<string>();

    await cache.fetch("k", load);
    await cache.fetch("k", load);

    expect(load).toHaveBeenCalledTimes(2);
  });

  it("reuses a value inside the TTL window", async () => {
    const load = vi.fn(async () => "v");
    let now = 1_000;
    const cache = new TtlCache<string>({ ttlMs: 500, now: () => now });

    await cache.fetch("k", load);
    now = 1_400; // still inside the window
    await cache.fetch("k", load);

    expect(load).toHaveBeenCalledTimes(1);
  });

  it("re-fetches once the TTL has elapsed", async () => {
    const load = vi.fn(async () => "v");
    let now = 1_000;
    const cache = new TtlCache<string>({ ttlMs: 500, now: () => now });

    await cache.fetch("k", load);
    now = 1_600; // past the window
    await cache.fetch("k", load);

    expect(load).toHaveBeenCalledTimes(2);
  });

  it("keys are independent", async () => {
    const load = vi.fn(async () => "v");
    const cache = new TtlCache<string>({ ttlMs: 60_000 });

    await cache.fetch("a", load);
    await cache.fetch("b", load);

    expect(load).toHaveBeenCalledTimes(2);
  });

  it("does not remember a failure - the next call retries", async () => {
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce("recovered");
    const cache = new TtlCache<string>({ ttlMs: 60_000 });

    await expect(cache.fetch("k", load)).rejects.toThrow("transient");
    expect(await cache.fetch("k", load)).toBe("recovered");
  });

  it("clear() drops retained values", async () => {
    const load = vi.fn(async () => "v");
    const cache = new TtlCache<string>({ ttlMs: 60_000 });

    await cache.fetch("k", load);
    cache.clear();
    await cache.fetch("k", load);

    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe("TtlCache stale grace", () => {
  const transient = () => true;

  it("serves the last good value when a transient failure lands inside the window", async () => {
    const load = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("good")
      .mockRejectedValueOnce(new Error("blip"));
    let now = 1_000;
    const cache = new TtlCache<string>({
      staleGraceMs: 5_000,
      isStaleServable: transient,
      now: () => now,
    });

    expect(await cache.fetch("k", load)).toBe("good");
    now = 3_000;
    expect(await cache.fetch("k", load)).toBe("good");
  });

  it("refuses once the value is older than the window", async () => {
    const load = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("good")
      .mockRejectedValueOnce(new Error("blip"));
    let now = 1_000;
    const cache = new TtlCache<string>({
      staleGraceMs: 5_000,
      isStaleServable: transient,
      now: () => now,
    });

    await cache.fetch("k", load);
    now = 20_000;
    await expect(cache.fetch("k", load)).rejects.toThrow("blip");
  });

  it("never serves stale for a failure the predicate rejects", async () => {
    // The whole safety property: an expired credential must surface, not
    // be papered over with the value fetched before it expired.
    const load = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("good")
      .mockRejectedValueOnce(new Error("expired"));
    const cache = new TtlCache<string>({
      staleGraceMs: 60_000,
      isStaleServable: () => false,
    });

    await cache.fetch("k", load);
    await expect(cache.fetch("k", load)).rejects.toThrow("expired");
  });

  it("measures the window from the last success, so a sustained outage cannot be ridden forever", async () => {
    const load = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("good")
      .mockRejectedValue(new Error("still down"));
    let now = 1_000;
    const cache = new TtlCache<string>({
      staleGraceMs: 5_000,
      isStaleServable: transient,
      now: () => now,
    });

    await cache.fetch("k", load);
    now = 3_000;
    expect(await cache.fetch("k", load)).toBe("good"); // inside the window
    now = 4_500;
    expect(await cache.fetch("k", load)).toBe("good"); // still inside
    now = 7_000;
    // Serving a stale value must not have reset the clock.
    await expect(cache.fetch("k", load)).rejects.toThrow("still down");
  });

  it("reports the staleness without ever handing over the value", async () => {
    const seen: Array<{ key: string; ageMs: number }> = [];
    const load = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("good")
      .mockRejectedValueOnce(new Error("blip"));
    let now = 1_000;
    const cache = new TtlCache<string>({
      staleGraceMs: 5_000,
      isStaleServable: transient,
      onStale: (key, ageMs) => seen.push({ key, ageMs }),
      now: () => now,
    });

    await cache.fetch("k", load);
    now = 2_500;
    await cache.fetch("k", load);

    expect(seen).toEqual([{ key: "k", ageMs: 1_500 }]);
  });

  it("stays off by default - a failure is a failure", async () => {
    const load = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("good")
      .mockRejectedValueOnce(new Error("blip"));
    const cache = new TtlCache<string>();

    await cache.fetch("k", load);
    await expect(cache.fetch("k", load)).rejects.toThrow("blip");
  });

  it("does not serve stale values as fresh when only a grace window is set", async () => {
    // staleGraceMs retains a value, but retention must not become caching:
    // with ttlMs still 0, a *successful* path re-fetches every time.
    const load = vi.fn(async () => "v");
    const cache = new TtlCache<string>({ staleGraceMs: 60_000, isStaleServable: transient });

    await cache.fetch("k", load);
    await cache.fetch("k", load);

    expect(load).toHaveBeenCalledTimes(2);
  });
});
