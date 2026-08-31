import json
from typing import Dict, List, Tuple

import pytest

from secrefs.control_plane_client import (
    ControlPlaneClient,
    ControlPlaneRequestError,
    MintedAWSCredentials,
    MintedBitwardenCredentials,
)


class FakeTransport:
    """Records the request it was given and replays a canned response."""

    def __init__(self, status: int, body: object, raw: bytes = b"") -> None:
        self._status = status
        self._body = raw if raw else json.dumps(body).encode("utf-8")
        self.calls: List[Tuple[str, Dict[str, str], bytes]] = []

    async def __call__(
        self, url: str, headers: Dict[str, str], body: bytes
    ) -> Tuple[int, bytes]:
        self.calls.append((url, headers, body))
        return self._status, self._body


class FailingTransport:
    def __init__(self, error: Exception) -> None:
        self._error = error

    async def __call__(
        self, url: str, headers: Dict[str, str], body: bytes
    ) -> Tuple[int, bytes]:
        raise self._error


AWS_RESPONSE = {
    "provider": "aws",
    "credentials": {
        "accessKeyId": "AKIA_MOCK",
        "secretAccessKey": "s",
        "sessionToken": "t",
        "expiration": "2026-01-01T00:00:00Z",
    },
}


async def test_posts_to_the_mint_endpoint_with_the_bearer_token():
    transport = FakeTransport(200, AWS_RESPONSE)
    client = ControlPlaneClient(
        base_url="https://cp.example.com", token="sfcp_test", transport=transport
    )

    result = await client.mint_credential("aws-prod", "prod/db")

    assert result.provider == "aws"
    assert isinstance(result.credentials, MintedAWSCredentials)
    assert result.credentials.access_key_id == "AKIA_MOCK"

    url, headers, body = transport.calls[0]
    assert url == "https://cp.example.com/v1/credentials/mint"
    assert headers["authorization"] == "Bearer sfcp_test"
    assert json.loads(body) == {"alias": "aws-prod", "path": "prod/db"}


async def test_strips_a_trailing_slash_from_base_url():
    transport = FakeTransport(200, AWS_RESPONSE)
    client = ControlPlaneClient(
        base_url="https://cp.example.com/", token="t", transport=transport
    )

    await client.mint_credential("aws-prod", "x")

    assert transport.calls[0][0] == "https://cp.example.com/v1/credentials/mint"


async def test_parses_a_bitwarden_credential():
    transport = FakeTransport(
        200,
        {
            "provider": "bitwarden",
            "credentials": {
                "accessToken": "0.distributed",
                "organizationId": "bw-org-1",
                "note": "not a TTL promise",
            },
        },
    )
    client = ControlPlaneClient(base_url="https://cp.example.com", token="t", transport=transport)

    result = await client.mint_credential("bw-prod", "prod-db")

    assert isinstance(result.credentials, MintedBitwardenCredentials)
    assert result.credentials.access_token == "0.distributed"
    assert result.credentials.organization_id == "bw-org-1"


async def test_leaves_credentials_unparsed_for_an_unknown_provider():
    # The calling provider rejects this with its own "expected aws"/"expected
    # bitwarden" message rather than a second, differently-worded failure.
    transport = FakeTransport(200, {"provider": "gcp", "credentials": {"whatever": 1}})
    client = ControlPlaneClient(base_url="https://cp.example.com", token="t", transport=transport)

    result = await client.mint_credential("gcp-prod", "prod/db")

    assert result.provider == "gcp"
    assert result.credentials is None


async def test_raises_with_the_servers_reason_on_a_denial():
    transport = FakeTransport(403, {"error": 'no grant authorizes path "prod/billing"'})
    client = ControlPlaneClient(base_url="https://cp.example.com", token="t", transport=transport)

    with pytest.raises(ControlPlaneRequestError, match="no grant authorizes"):
        await client.mint_credential("aws-prod", "prod/billing")


async def test_sets_status_on_the_request_error():
    transport = FakeTransport(401, {"error": "missing or unrecognized bootstrap token"})
    client = ControlPlaneClient(base_url="https://cp.example.com", token="bad", transport=transport)

    with pytest.raises(ControlPlaneRequestError) as exc_info:
        await client.mint_credential("aws-prod", "prod/db")
    assert exc_info.value.status == 401


async def test_falls_back_to_a_generic_message_when_the_error_body_is_not_json():
    transport = FakeTransport(502, None, raw=b"not json")
    client = ControlPlaneClient(base_url="https://cp.example.com", token="t", transport=transport)

    with pytest.raises(ControlPlaneRequestError, match="502"):
        await client.mint_credential("aws-prod", "prod/db")


async def test_wraps_a_transport_failure_naming_the_control_plane_url():
    client = ControlPlaneClient(
        base_url="https://cp.example.com",
        token="t",
        transport=FailingTransport(OSError("Connection refused")),
    )

    with pytest.raises(ValueError, match="could not reach control plane at https://cp.example.com"):
        await client.mint_credential("aws-prod", "prod/db")
