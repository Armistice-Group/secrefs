import asyncio
import json
import time
from typing import Any, Dict, List

import pytest

import secrefs.providers.aws as aws_module
from secrefs.control_plane_client import (
    ControlPlaneCredentialSource,
    ControlPlaneRequestError,
    MintCredentialResponse,
    MintedAWSCredentials,
    MintedBitwardenCredentials,
)
from secrefs.providers.aws import AWSSecretsManagerProvider
from secrefs.providers.base import SecretFetchRequest


class FakeSecretsManagerClient:
    """Stands in for a boto3 secretsmanager client. Each entry in `values` is
    returned by one successive call, so a test can rotate the secret."""

    def __init__(self, *values: str, delay: float = 0.0) -> None:
        self._values = list(values)
        self._delay = delay
        self.calls: List[str] = []

    def get_secret_value(self, SecretId: str) -> Dict[str, Any]:  # noqa: N803 - boto3's own kwarg
        if self._delay:
            # Provider calls run via asyncio.to_thread, so a blocking sleep
            # here genuinely overlaps two concurrent expansions.
            time.sleep(self._delay)
        self.calls.append(SecretId)
        return {"SecretString": self._values[min(len(self.calls) - 1, len(self._values) - 1)]}

    def list_secrets(self, MaxResults: int) -> Dict[str, Any]:  # noqa: N803
        return {"SecretList": []}


class FakeControlPlaneClient:
    def __init__(self, response: Any) -> None:
        self._response = response
        self.calls: List[tuple] = []

    async def mint_credential(self, alias: str, path: str) -> MintCredentialResponse:
        self.calls.append((alias, path))
        if isinstance(self._response, Exception):
            raise self._response
        return self._response


def source(client: Any) -> ControlPlaneCredentialSource:
    return ControlPlaneCredentialSource(
        base_url="https://cp.example.com", token="sfcp_test", alias="aws-prod", client=client
    )


MINTED_AWS = MintCredentialResponse(
    provider="aws",
    credentials=MintedAWSCredentials(
        access_key_id="AKIA_MINTED",
        secret_access_key="s",
        session_token="t",
        expiration="2026-01-01T00:00:00Z",
    ),
)


class TestAmbientMode:
    async def test_fetches_via_the_injected_client_and_extracts_a_field(self):
        client = FakeSecretsManagerClient(json.dumps({"password": "hunter2"}))
        provider = AWSSecretsManagerProvider(client=client)

        value = await provider.fetch_one(SecretFetchRequest(path="prod/db", field="password"))

        assert value == "hunter2"

    async def test_refetches_on_every_expansion_by_default(self):
        client = FakeSecretsManagerClient(json.dumps({"a": "1"}))
        provider = AWSSecretsManagerProvider(client=client)

        await provider.fetch_one(SecretFetchRequest(path="prod/db", field="a"))
        await provider.fetch_one(SecretFetchRequest(path="prod/db", field="a"))

        # The whole point of a sec:// reference is that the value behind it
        # can change. Caching by default would mean a long-running consumer
        # held the pre-rotation value until it restarted.
        assert len(client.calls) == 2

    async def test_returns_the_new_value_after_the_source_rotates(self):
        client = FakeSecretsManagerClient(
            json.dumps({"password": "old"}), json.dumps({"password": "rotated"})
        )
        provider = AWSSecretsManagerProvider(client=client)

        first = await provider.fetch_one(SecretFetchRequest(path="prod/db", field="password"))
        second = await provider.fetch_one(SecretFetchRequest(path="prod/db", field="password"))

        assert (first, second) == ("old", "rotated")

    async def test_coalesces_concurrent_expansions_of_the_same_reference(self):
        client = FakeSecretsManagerClient(json.dumps({"a": "1", "b": "2"}), delay=0.05)
        provider = AWSSecretsManagerProvider(client=client)

        # Sharing an in-flight request is not the same as caching its result:
        # nothing is held past the moment it settles.
        values = await asyncio.gather(
            provider.fetch_one(SecretFetchRequest(path="prod/db", field="a")),
            provider.fetch_one(SecretFetchRequest(path="prod/db", field="b")),
        )

        assert values == ["1", "2"]
        assert len(client.calls) == 1

    async def test_reuses_a_value_within_an_explicit_cache_ttl_window(self):
        client = FakeSecretsManagerClient(json.dumps({"a": "1"}))
        provider = AWSSecretsManagerProvider(client=client, cache_ttl_ms=60_000)

        await provider.fetch_one(SecretFetchRequest(path="prod/db", field="a"))
        await provider.fetch_one(SecretFetchRequest(path="prod/db", field="a"))

        assert len(client.calls) == 1

    async def test_reports_a_failed_fetch_with_the_path(self):
        class Broken:
            def get_secret_value(self, SecretId: str) -> Dict[str, Any]:  # noqa: N803
                raise RuntimeError("ResourceNotFoundException")

        provider = AWSSecretsManagerProvider(client=Broken())

        with pytest.raises(ValueError, match='could not fetch secret "prod/db"'):
            await provider.fetch_one(SecretFetchRequest(path="prod/db"))


class TestControlPlaneMode:
    async def test_mints_a_credential_per_path_and_builds_a_client_from_it(self, monkeypatch):
        control_plane = FakeControlPlaneClient(MINTED_AWS)
        built: List[Dict[str, Any]] = []

        def fake_boto3_client(service: str, **kwargs: Any) -> Any:
            built.append({"service": service, **kwargs})
            return FakeSecretsManagerClient(json.dumps({"password": "hunter2"}))

        monkeypatch.setattr(aws_module.boto3, "client", fake_boto3_client)
        provider = AWSSecretsManagerProvider(
            region="us-east-1", control_plane=source(control_plane)
        )

        value = await provider.fetch_one(SecretFetchRequest(path="prod/db", field="password"))

        assert value == "hunter2"
        assert control_plane.calls == [("aws-prod", "prod/db")]
        assert built[0]["aws_access_key_id"] == "AKIA_MINTED"
        assert built[0]["aws_session_token"] == "t"

    async def test_builds_a_fresh_client_per_path_rather_than_reusing_one(self, monkeypatch):
        # Each minted credential is scoped to exactly one secret, so reusing
        # the client built from the first would silently widen that scope.
        control_plane = FakeControlPlaneClient(MINTED_AWS)
        built: List[str] = []

        def fake_boto3_client(service: str, **kwargs: Any) -> Any:
            built.append(service)
            return FakeSecretsManagerClient(json.dumps({"a": "1"}))

        monkeypatch.setattr(aws_module.boto3, "client", fake_boto3_client)
        provider = AWSSecretsManagerProvider(
            region="us-east-1", control_plane=source(control_plane)
        )

        await provider.fetch_one(SecretFetchRequest(path="prod/db", field="a"))
        await provider.fetch_one(SecretFetchRequest(path="prod/api-key", field="a"))

        assert control_plane.calls == [("aws-prod", "prod/db"), ("aws-prod", "prod/api-key")]
        assert len(built) == 2

    async def test_rejects_a_non_aws_credential_for_this_alias(self):
        control_plane = FakeControlPlaneClient(
            MintCredentialResponse(
                provider="bitwarden",
                credentials=MintedBitwardenCredentials(access_token="x", note="n"),
            )
        )
        provider = AWSSecretsManagerProvider(control_plane=source(control_plane))

        with pytest.raises(ValueError, match='returned a "bitwarden" credential'):
            await provider.fetch_one(SecretFetchRequest(path="prod/db"))

    async def test_propagates_a_denial_as_the_fetch_failure(self):
        control_plane = FakeControlPlaneClient(
            ControlPlaneRequestError(403, 'no grant authorizes path "prod/billing"')
        )
        provider = AWSSecretsManagerProvider(control_plane=source(control_plane))

        with pytest.raises(ValueError, match="no grant authorizes"):
            await provider.fetch_one(SecretFetchRequest(path="prod/billing"))

    async def test_health_check_is_ok_when_the_control_plane_denies_the_synthetic_path(self):
        control_plane = FakeControlPlaneClient(
            ControlPlaneRequestError(403, "no grant authorizes this synthetic path")
        )
        provider = AWSSecretsManagerProvider(control_plane=source(control_plane))

        health = await provider.health_check()

        # A denial still proves reachability and that the token was accepted.
        assert health.ok is True

    async def test_health_check_fails_when_the_control_plane_is_unreachable(self):
        control_plane = FakeControlPlaneClient(
            ValueError("could not reach control plane at https://cp.example.com: ECONNREFUSED")
        )
        provider = AWSSecretsManagerProvider(control_plane=source(control_plane))

        health = await provider.health_check()

        assert health.ok is False
        assert health.message is not None and "ECONNREFUSED" in health.message
