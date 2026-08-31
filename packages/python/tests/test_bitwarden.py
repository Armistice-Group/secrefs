import importlib.util
import json
from types import SimpleNamespace
from typing import Any, List, Optional, Tuple

import pytest

from secrefs.control_plane_client import (
    ControlPlaneCredentialSource,
    ControlPlaneRequestError,
    MintCredentialResponse,
    MintedAWSCredentials,
    MintedBitwardenCredentials,
)
from secrefs.providers.base import SecretFetchRequest
from secrefs.providers.bitwarden import BitwardenProvider

SECRET_UUID = "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d"
OTHER_UUID = "6ec0bd7f-11c0-43da-975e-2a8ad9ebae0b"


class FakeBitwardenClient:
    """Mirrors the shape of bitwarden_sdk's BitwardenClient: chained
    auth()/secrets() accessors returning responses wrapped in the SDK's
    {success, data, errorMessage} envelope."""

    def __init__(self, value: str = json.dumps({"password": "hunter2"})) -> None:
        self._value = value
        self.logins: List[Tuple[str, Optional[str]]] = []
        self.gets: List[str] = []
        self.lists: List[str] = []
        self.login_error: Optional[Exception] = None

    def auth(self) -> Any:
        return SimpleNamespace(login_access_token=self._login)

    def secrets(self) -> Any:
        return SimpleNamespace(get=self._get, list=self._list)

    def _login(self, access_token: str, state_file: Optional[str] = None) -> Any:
        self.logins.append((access_token, state_file))
        if self.login_error is not None:
            raise self.login_error
        return SimpleNamespace(success=True, data=SimpleNamespace(authenticated=True))

    def _get(self, secret_id: str) -> Any:
        self.gets.append(secret_id)
        return SimpleNamespace(success=True, data=SimpleNamespace(value=self._value))

    def _list(self, organization_id: str) -> Any:
        self.lists.append(organization_id)
        return SimpleNamespace(
            success=True,
            data=SimpleNamespace(
                data=[
                    SimpleNamespace(id=SECRET_UUID, key="prod-db"),
                    SimpleNamespace(id=OTHER_UUID, key="prod-api-key"),
                ]
            ),
        )


class FakeControlPlaneClient:
    def __init__(self, response: Any) -> None:
        self._response = response
        self.calls: List[Tuple[str, str]] = []

    async def mint_credential(self, alias: str, path: str) -> MintCredentialResponse:
        self.calls.append((alias, path))
        if isinstance(self._response, Exception):
            raise self._response
        return self._response


def source(client: Any) -> ControlPlaneCredentialSource:
    return ControlPlaneCredentialSource(
        base_url="https://cp.example.com", token="sfcp_test", alias="bw-prod", client=client
    )


DISTRIBUTED = MintCredentialResponse(
    provider="bitwarden",
    credentials=MintedBitwardenCredentials(
        access_token="0.distributed-token", note="n", organization_id="bw-org-1"
    ),
)


@pytest.fixture(autouse=True)
def _no_ambient_bws_env(monkeypatch):
    """Ambient BWS_* variables in the developer's own shell would otherwise
    silently change what these tests exercise."""
    for name in ("BWS_ACCESS_TOKEN", "BWS_ORGANIZATION_ID", "BWS_API_URL", "BWS_IDENTITY_URL"):
        monkeypatch.delenv(name, raising=False)


@pytest.fixture
def client() -> FakeBitwardenClient:
    return FakeBitwardenClient()


@pytest.fixture
def provider(client: FakeBitwardenClient) -> BitwardenProvider:
    return BitwardenProvider(
        access_token="0.mock-access-token", organization_id="org-1", client=client
    )


class TestAmbientMode:
    async def test_fetches_by_uuid_directly_extracting_the_requested_field(self, provider, client):
        value = await provider.fetch_one(SecretFetchRequest(path=SECRET_UUID, field="password"))

        assert value == "hunter2"
        assert client.logins == [("0.mock-access-token", None)]
        assert client.gets == [SECRET_UUID]
        # A UUID path never needs the name->id lookup.
        assert client.lists == []

    async def test_resolves_a_secret_by_name_when_an_organization_id_is_configured(
        self, provider, client
    ):
        value = await provider.fetch_one(SecretFetchRequest(path="prod-db", field="password"))

        assert value == "hunter2"
        assert client.gets == [SECRET_UUID]
        assert client.lists == ["org-1"]

    async def test_caches_the_name_to_id_map(self, provider, client):
        await provider.fetch_one(SecretFetchRequest(path="prod-db", field="password"))
        await provider.fetch_one(SecretFetchRequest(path="prod-api-key", field="password"))

        assert len(client.lists) == 1

    async def test_only_logs_in_once_across_multiple_fetches(self, provider, client):
        await provider.fetch_one(SecretFetchRequest(path=SECRET_UUID, field="password"))
        await provider.fetch_one(SecretFetchRequest(path=SECRET_UUID, field="password"))

        assert len(client.logins) == 1

    async def test_refetches_the_secret_on_every_expansion(self, provider, client):
        # Bitwarden secret values themselves are never cached: an
        # authenticated session is reused, the value behind it is not.
        await provider.fetch_one(SecretFetchRequest(path=SECRET_UUID, field="password"))
        await provider.fetch_one(SecretFetchRequest(path=SECRET_UUID, field="password"))

        assert len(client.gets) == 2

    async def test_rejects_a_non_uuid_path_when_no_organization_id_is_configured(self, client):
        provider = BitwardenProvider(access_token="token", client=client)

        with pytest.raises(ValueError, match="no organization_id is available"):
            await provider.fetch_one(SecretFetchRequest(path="prod-db"))

    async def test_errors_clearly_when_a_name_has_no_matching_secret(self, provider):
        with pytest.raises(ValueError, match='no secret named "does-not-exist"'):
            await provider.fetch_one(SecretFetchRequest(path="does-not-exist"))

    async def test_passes_a_state_file_through_only_when_explicitly_configured(self, client):
        provider = BitwardenProvider(
            access_token="token", client=client, state_file="/tmp/bws-state"
        )

        await provider.fetch_one(SecretFetchRequest(path=SECRET_UUID))

        assert client.logins == [("token", "/tmp/bws-state")]

    async def test_errors_when_no_access_token_is_available(self):
        provider = BitwardenProvider()

        with pytest.raises(ValueError, match="BWS_ACCESS_TOKEN is not set"):
            await provider.fetch_one(SecretFetchRequest(path=SECRET_UUID))

    async def test_does_not_remember_a_failed_login(self, client):
        client.login_error = RuntimeError("rate limited")
        provider = BitwardenProvider(access_token="token", client=client)

        with pytest.raises(ValueError, match="rate limited"):
            await provider.fetch_one(SecretFetchRequest(path=SECRET_UUID))

        client.login_error = None
        assert await provider.fetch_one(SecretFetchRequest(path=SECRET_UUID, field="password"))
        assert len(client.logins) == 2

    async def test_health_check_reports_not_ok_rather_than_raising_when_login_fails(self, client):
        client.login_error = RuntimeError("bad token")
        provider = BitwardenProvider(access_token="bad", client=client)

        health = await provider.health_check()

        assert health.ok is False
        assert health.message is not None and "bad token" in health.message

    async def test_health_check_reports_ok_on_a_successful_login(self, provider):
        assert (await provider.health_check()).ok is True

    @pytest.mark.skipif(
        importlib.util.find_spec("bitwarden_sdk") is not None,
        reason="bitwarden-sdk is installed, so the missing-extra path can't be exercised",
    )
    async def test_explains_how_to_install_the_sdk_when_it_is_absent(self):
        provider = BitwardenProvider(access_token="token")

        with pytest.raises(ValueError, match=r"secrefs\[bitwarden\]"):
            await provider.fetch_one(SecretFetchRequest(path=SECRET_UUID))


class TestControlPlaneMode:
    async def test_distributes_a_credential_per_path_and_logs_in_with_it(self, client):
        control_plane = FakeControlPlaneClient(DISTRIBUTED)
        provider = BitwardenProvider(client=client, control_plane=source(control_plane))

        value = await provider.fetch_one(SecretFetchRequest(path=SECRET_UUID, field="password"))

        assert value == "hunter2"
        assert control_plane.calls == [("bw-prod", SECRET_UUID)]
        assert client.logins == [("0.distributed-token", None)]

    async def test_uses_the_distributed_organization_id_to_resolve_a_name(self, client):
        control_plane = FakeControlPlaneClient(DISTRIBUTED)
        provider = BitwardenProvider(client=client, control_plane=source(control_plane))

        value = await provider.fetch_one(SecretFetchRequest(path="prod-db", field="password"))

        assert value == "hunter2"
        assert client.lists == ["bw-org-1"]

    async def test_requests_a_distribution_for_every_distinct_path(self, client):
        # RBAC is re-checked per secret even though the token it returns
        # doesn't vary - the SDK login itself is skipped the second time.
        control_plane = FakeControlPlaneClient(DISTRIBUTED)
        provider = BitwardenProvider(client=client, control_plane=source(control_plane))

        await provider.fetch_one(SecretFetchRequest(path=SECRET_UUID))
        await provider.fetch_one(SecretFetchRequest(path=OTHER_UUID))

        assert control_plane.calls == [("bw-prod", SECRET_UUID), ("bw-prod", OTHER_UUID)]
        assert len(client.logins) == 1

    async def test_rejects_a_non_bitwarden_credential_for_this_alias(self, client):
        control_plane = FakeControlPlaneClient(
            MintCredentialResponse(
                provider="aws",
                credentials=MintedAWSCredentials(
                    access_key_id="x",
                    secret_access_key="y",
                    session_token="z",
                    expiration="2026-01-01T00:00:00Z",
                ),
            )
        )
        provider = BitwardenProvider(client=client, control_plane=source(control_plane))

        with pytest.raises(ValueError, match='returned a "aws" credential'):
            await provider.fetch_one(SecretFetchRequest(path=SECRET_UUID))

    async def test_propagates_a_denial_as_the_fetch_failure(self, client):
        control_plane = FakeControlPlaneClient(
            ControlPlaneRequestError(403, 'no grant authorizes path "prod-billing"')
        )
        provider = BitwardenProvider(client=client, control_plane=source(control_plane))

        with pytest.raises(ValueError, match="no grant authorizes"):
            await provider.fetch_one(SecretFetchRequest(path="prod-billing"))
