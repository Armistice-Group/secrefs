import asyncio
import time
from typing import Any, Dict, List

import pytest

from secrefs.providers.base import SecretFetchRequest
from secrefs.providers.vault import VaultProvider


class FakeVaultClient:
    """Stands in for an hvac client. Each entry in `payloads` is returned by
    one successive read, so a test can rotate the secret."""

    def __init__(self, *payloads: Dict[str, Any], delay: float = 0.0) -> None:
        self._payloads = list(payloads)
        self._delay = delay
        self.calls: List[str] = []

    def read(self, path: str) -> Dict[str, Any]:
        if self._delay:
            time.sleep(self._delay)
        self.calls.append(path)
        return self._payloads[min(len(self.calls) - 1, len(self._payloads) - 1)]


def kv2(**secret: str) -> Dict[str, Any]:
    return {"data": {"data": dict(secret), "metadata": {"version": 1}}}


async def test_reads_a_kv2_secret_and_extracts_a_field():
    client = FakeVaultClient(kv2(password="hunter2", user="admin"))
    provider = VaultProvider(client=client)

    value = await provider.fetch_one(SecretFetchRequest(path="secret/data/db", field="password"))

    assert value == "hunter2"


async def test_reads_a_kv1_secret():
    client = FakeVaultClient({"data": {"value": "plain"}})
    provider = VaultProvider(client=client)

    assert await provider.fetch_one(SecretFetchRequest(path="secret/db")) == "plain"


async def test_rereads_on_every_expansion_by_default():
    client = FakeVaultClient(kv2(password="hunter2"))
    provider = VaultProvider(client=client)

    await provider.fetch_one(SecretFetchRequest(path="secret/data/db", field="password"))
    await provider.fetch_one(SecretFetchRequest(path="secret/data/db", field="password"))

    assert len(client.calls) == 2


async def test_returns_the_new_value_after_the_source_rotates():
    client = FakeVaultClient(kv2(password="old"), kv2(password="rotated"))
    provider = VaultProvider(client=client)

    first = await provider.fetch_one(SecretFetchRequest(path="secret/data/db", field="password"))
    second = await provider.fetch_one(SecretFetchRequest(path="secret/data/db", field="password"))

    assert (first, second) == ("old", "rotated")


async def test_coalesces_concurrent_expansions_of_the_same_reference():
    client = FakeVaultClient(kv2(password="hunter2", user="admin"), delay=0.05)
    provider = VaultProvider(client=client)

    values = await asyncio.gather(
        provider.fetch_one(SecretFetchRequest(path="secret/data/db", field="password")),
        provider.fetch_one(SecretFetchRequest(path="secret/data/db", field="user")),
    )

    assert values == ["hunter2", "admin"]
    assert len(client.calls) == 1


async def test_reuses_a_value_within_an_explicit_cache_ttl_window():
    client = FakeVaultClient(kv2(password="hunter2"))
    provider = VaultProvider(client=client, cache_ttl_ms=60_000)

    await provider.fetch_one(SecretFetchRequest(path="secret/data/db", field="password"))
    await provider.fetch_one(SecretFetchRequest(path="secret/data/db", field="password"))

    assert len(client.calls) == 1


async def test_does_not_remember_a_failed_read():
    class Flaky:
        def __init__(self) -> None:
            self.calls = 0

        def read(self, path: str) -> Dict[str, Any]:
            self.calls += 1
            if self.calls == 1:
                raise RuntimeError("connection reset")
            return kv2(password="recovered")

    client = Flaky()
    provider = VaultProvider(client=client, cache_ttl_ms=60_000)

    with pytest.raises(ValueError, match="connection reset"):
        await provider.fetch_one(SecretFetchRequest(path="secret/data/db", field="password"))
    value = await provider.fetch_one(SecretFetchRequest(path="secret/data/db", field="password"))

    assert value == "recovered"


async def test_reports_an_unconfigured_endpoint_as_a_configuration_error(monkeypatch):
    # Not wrapped as a failed read: nothing was read, and the caller needs to
    # be told what to set.
    monkeypatch.delenv("VAULT_ADDR", raising=False)
    monkeypatch.delenv("VAULT_TOKEN", raising=False)
    provider = VaultProvider()

    with pytest.raises(ValueError, match="VAULT_ADDR is not set"):
        await provider.fetch_one(SecretFetchRequest(path="secret/data/db"))
