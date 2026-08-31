import asyncio

import pytest

from secrefs.ttl_cache import TtlCache


class Counter:
    """A load function that records how many times it was actually called."""

    def __init__(self, *values: str) -> None:
        self._values = list(values) or ["v"]
        self.calls = 0

    async def __call__(self) -> str:
        self.calls += 1
        return self._values[min(self.calls - 1, len(self._values) - 1)]


async def test_refetches_every_time_by_default():
    load = Counter()
    cache: TtlCache[str] = TtlCache()

    await cache.fetch("k", load)
    await cache.fetch("k", load)

    # A value is never held past its use - see the module docstring.
    assert load.calls == 2


async def test_returns_the_new_value_when_the_source_changes():
    load = Counter("old", "rotated")
    cache: TtlCache[str] = TtlCache()

    assert await cache.fetch("k", load) == "old"
    assert await cache.fetch("k", load) == "rotated"


async def test_coalesces_concurrent_calls_even_with_caching_off():
    # The bug this guards against: gating coalescing behind `ttl_ms > 0`
    # looks harmless, but with the (default) zero TTL it means two
    # concurrent expansions of one reference make two requests.
    started = asyncio.Event()
    release = asyncio.Event()
    calls = 0

    async def load() -> str:
        nonlocal calls
        calls += 1
        started.set()
        await release.wait()
        return "v"

    cache: TtlCache[str] = TtlCache()
    first = asyncio.ensure_future(cache.fetch("k", load))
    await started.wait()
    second = asyncio.ensure_future(cache.fetch("k", load))
    await asyncio.sleep(0)  # let `second` reach the in-flight join
    release.set()

    assert await first == "v"
    assert await second == "v"
    assert calls == 1


async def test_does_not_coalesce_calls_made_after_the_first_settles():
    load = Counter()
    cache: TtlCache[str] = TtlCache()

    await cache.fetch("k", load)
    await cache.fetch("k", load)

    assert load.calls == 2


async def test_a_cancelled_joiner_does_not_cancel_the_shared_request():
    release = asyncio.Event()
    calls = 0

    async def load() -> str:
        nonlocal calls
        calls += 1
        await release.wait()
        return "v"

    cache: TtlCache[str] = TtlCache()
    first = asyncio.ensure_future(cache.fetch("k", load))
    await asyncio.sleep(0)
    second = asyncio.ensure_future(cache.fetch("k", load))
    await asyncio.sleep(0)

    first.cancel()
    with pytest.raises(asyncio.CancelledError):
        await first
    release.set()

    assert await second == "v"
    assert calls == 1


async def test_reuses_a_value_inside_the_ttl_window():
    load = Counter()
    now = 1000.0
    cache: TtlCache[str] = TtlCache(ttl_ms=500, now=lambda: now)

    await cache.fetch("k", load)
    now = 1400.0  # still inside the window
    await cache.fetch("k", load)

    assert load.calls == 1


async def test_refetches_once_the_ttl_has_elapsed():
    load = Counter()
    now = 1000.0
    cache: TtlCache[str] = TtlCache(ttl_ms=500, now=lambda: now)

    await cache.fetch("k", load)
    now = 1600.0  # past the window
    await cache.fetch("k", load)

    assert load.calls == 2


async def test_keys_are_independent():
    load = Counter()
    cache: TtlCache[str] = TtlCache(ttl_ms=60_000)

    await cache.fetch("a", load)
    await cache.fetch("b", load)

    assert load.calls == 2


async def test_does_not_remember_a_failure():
    calls = 0

    async def load() -> str:
        nonlocal calls
        calls += 1
        if calls == 1:
            raise ValueError("transient")
        return "recovered"

    cache: TtlCache[str] = TtlCache(ttl_ms=60_000)

    with pytest.raises(ValueError, match="transient"):
        await cache.fetch("k", load)
    assert await cache.fetch("k", load) == "recovered"


async def test_clear_drops_retained_values():
    load = Counter()
    cache: TtlCache[str] = TtlCache(ttl_ms=60_000)

    await cache.fetch("k", load)
    cache.clear()
    await cache.fetch("k", load)

    assert load.calls == 2
