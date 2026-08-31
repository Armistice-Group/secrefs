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
