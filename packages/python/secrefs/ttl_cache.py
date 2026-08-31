"""
A cache that expires, used by every provider that fetches over the network.

The default TTL is **zero** - every read re-fetches. That's deliberate and
it's the whole point of the product: a `sec://` reference is a stable name
for a value that changes underneath it. A consumer holding the reference is
supposed to see a rotated secret without being redeployed, and a cache with
no expiry silently breaks exactly that. Before this existed, a long-running
process fetched a secret once and held the pre-rotation value until restart.

A non-zero TTL is a real tradeoff, not a mistake: every expansion is a
network round trip, so a busy caller may want to trade a bounded window of
staleness for latency and API-rate-limit headroom. `ttl_ms=30_000` means "a
rotation reaches me within 30 seconds" - usually fine, and it should be a
decision someone made rather than a default they inherited.
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from typing import Awaitable, Callable, Dict, Generic, Optional, TypeVar

T = TypeVar("T")


def _monotonic_ms() -> float:
    """Monotonic rather than wall clock: a TTL is a duration, and an NTP
    step or a DST change shouldn't stretch or collapse one."""
    return time.monotonic() * 1000


@dataclass
class _Entry(Generic[T]):
    value: T
    stored_at: float


class TtlCache(Generic[T]):
    def __init__(
        self,
        ttl_ms: float = 0.0,
        now: Optional[Callable[[], float]] = None,
    ) -> None:
        """`ttl_ms` is how long an entry stays fresh; 0 (the default)
        disables caching entirely - every `fetch` call goes to the source.
        `now` is injected in tests so expiry doesn't require real waiting."""
        self._ttl_ms = ttl_ms
        self._now = now or _monotonic_ms
        # Settled values, only ever populated when a TTL is configured.
        self._entries: Dict[str, _Entry[T]] = {}
        # Requests currently in flight, tracked separately from `_entries`
        # because coalescing and caching are different things: sharing an
        # unsettled request holds no value past the moment it resolves, so
        # it stays correct even with caching fully disabled.
        self._in_flight: Dict[str, "asyncio.Future[T]"] = {}

    async def fetch(self, key: str, load: Callable[[], Awaitable[T]]) -> T:
        """
        Returns the cached value for `key` if it's still fresh, otherwise
        awaits `load()` and caches that. In-flight requests are shared, so N
        concurrent expansions of the same reference make one request rather
        than N even when the TTL is zero - that's request coalescing, not
        caching, and it doesn't hold a value past its use.

        A failed load is dropped rather than remembered, so a transient
        failure doesn't become a sticky one.
        """
        # Always join an in-flight request, whatever the TTL.
        pending = self._in_flight.get(key)
        if pending is None:
            entry = self._entries.get(key)
            if (
                entry is not None
                and self._ttl_ms > 0
                and self._now() - entry.stored_at < self._ttl_ms
            ):
                return entry.value

            pending = asyncio.ensure_future(load())
            self._in_flight[key] = pending
            # Cleared by the request itself rather than in a `finally` below,
            # so the entry disappears exactly when the request settles even
            # if the caller that started it was cancelled first.
            pending.add_done_callback(lambda _task: self._in_flight.pop(key, None))

        try:
            # Shielded: one caller giving up (a cancelled `expand_string`,
            # say) must not cancel the request every other caller joined.
            value = await asyncio.shield(pending)
        except Exception:
            # Never remember a failure - a transient outage shouldn't become
            # a sticky one for the length of the TTL.
            self._entries.pop(key, None)
            raise

        if self._ttl_ms > 0:
            # The settled value, not the future it came from: a retained
            # entry can outlive the event loop that produced it, and an
            # awaitable can't be awaited from a different one.
            self._entries[key] = _Entry(value=value, stored_at=self._now())
        return value

    def clear(self) -> None:
        """Drops everything retained - used when a credential changes
        underneath the cache and anything fetched with the old one is
        suspect."""
        self._entries.clear()
