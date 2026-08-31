"""
Thin HTTP client for a running control plane's credential-broker endpoint
(docs/control-plane-design.md §7). This is the piece §10 flagged as the
missing link: every provider that supports control-plane-sourced credentials
(AWSSecretsManagerProvider, BitwardenProvider - see their `control_plane`
constructor option) constructs one of these instead of only ever reading
ambient env vars.

Deliberately just an HTTP wrapper with no retry/backoff/circuit-breaking
logic - a mint failure surfaces as a normal raised exception, same as any
other provider fetch failure, and the caller's existing error handling
(resolver.py's asyncio.gather aggregation) already does the right thing
with it.

The default transport is `urllib` from the standard library, offloaded to a
thread with `asyncio.to_thread` exactly the way boto3 and hvac calls are.
One POST to one endpoint doesn't justify making every SecRefs install carry
an HTTP client dependency it otherwise has no use for; a caller who wants
their own (httpx, aiohttp, a test double) passes `transport`.
"""

from __future__ import annotations

import asyncio
import json
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Dict, Optional, Tuple, Union

MINT_ENDPOINT = "/v1/credentials/mint"


@dataclass(frozen=True)
class MintedAWSCredentials:
    access_key_id: str
    secret_access_key: str
    session_token: str
    expiration: str  # ISO-8601 timestamp


@dataclass(frozen=True)
class MintedBitwardenCredentials:
    access_token: str
    # Explicitly not a TTL promise - see
    # apps/control-plane/src/providers/bitwarden.ts.
    note: str = ""
    organization_id: Optional[str] = None


MintedCredentials = Union[MintedAWSCredentials, MintedBitwardenCredentials]


@dataclass(frozen=True)
class MintCredentialResponse:
    provider: str
    # None when the control plane names a provider this SDK doesn't know how
    # to parse credentials for. Left to the calling provider to reject, so
    # the error it raises is the same "returned a X credential, expected Y"
    # one it raises for a known-but-wrong provider rather than a second,
    # differently-worded failure mode.
    credentials: Optional[MintedCredentials] = None


@dataclass(frozen=True)
class ControlPlaneCredentialSource:
    """What a provider's `control_plane` constructor option needs - shared
    shape between AWSSecretsManagerProvider and BitwardenProvider (and any
    future control-plane-aware provider)."""

    base_url: str
    """Base URL of a running control plane, e.g. from $SECREFS_CONTROL_PLANE_URL."""
    token: str
    """Bootstrap token or a verified OIDC token, e.g. from $SECREFS_CONTROL_PLANE_TOKEN."""
    alias: str
    """Which VaultConnection alias this provider instance represents - this
    is what the control plane's RBAC grants are scoped against, not the
    `sec://` alias this provider happens to be registered under (though in
    practice they're usually the same string)."""
    client: Optional["ControlPlaneClient"] = None
    """Injected for testing - defaults to a real ControlPlaneClient."""


# (url, headers, body) -> (status, body). A non-2xx status is a *response*,
# not an exception: the body carries the control plane's denial reason and
# the caller needs it verbatim.
ControlPlaneTransport = Callable[[str, Dict[str, str], bytes], Awaitable[Tuple[int, bytes]]]


async def _urllib_transport(url: str, headers: Dict[str, str], body: bytes) -> Tuple[int, bytes]:
    def send() -> Tuple[int, bytes]:
        request = urllib.request.Request(url, data=body, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(request) as response:  # noqa: S310 - caller-supplied https URL
                return int(response.status), bytes(response.read())
        except urllib.error.HTTPError as exc:
            # urllib raises on 4xx/5xx; a denial is a well-formed answer
            # here, so hand the status and body back rather than the error.
            return int(exc.code), bytes(exc.read())

    return await asyncio.to_thread(send)


class ControlPlaneRequestError(Exception):
    """Raised for a well-formed error response from the control plane (401,
    403, 502, ...) - `status` and the message come straight from its
    `{"error": ...}` body, so a denial reason (e.g. 'no grant authorizes
    path...') reaches the caller verbatim rather than as an opaque HTTP
    failure."""

    def __init__(self, status: int, message: str) -> None:
        self.status = status
        super().__init__(message)


class ControlPlaneClient:
    def __init__(
        self,
        base_url: str,
        token: str,
        transport: Optional[ControlPlaneTransport] = None,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._token = token
        self._transport: ControlPlaneTransport = transport or _urllib_transport

    async def mint_credential(self, alias: str, path: str) -> MintCredentialResponse:
        """Authenticates, authorizes, and resolves a credential for
        `alias`/`path` - see the control plane's POST /v1/credentials/mint.
        Raises ControlPlaneRequestError for any non-2xx response."""
        url = f"{self._base_url}{MINT_ENDPOINT}"
        headers = {
            "content-type": "application/json",
            "authorization": f"Bearer {self._token}",
        }
        body = json.dumps({"alias": alias, "path": path}).encode("utf-8")

        try:
            status, raw = await self._transport(url, headers, body)
        except Exception as exc:  # noqa: BLE001 - re-raised with the URL for context
            raise ValueError(f"could not reach control plane at {self._base_url}: {exc}") from exc

        if not 200 <= status < 300:
            raise ControlPlaneRequestError(
                status,
                _error_message(raw)
                or f'control plane returned {status} for alias "{alias}" path "{path}"',
            )

        try:
            payload = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise ValueError(
                f"control plane returned a non-JSON success response for alias "
                f'"{alias}" path "{path}": {exc}'
            ) from exc

        return _parse_mint_response(payload)


def _error_message(raw: bytes) -> Optional[str]:
    """The `{"error": ...}` body an error response is supposed to carry.
    None if it isn't there - a proxy or load balancer in front of the
    control plane may return HTML or nothing at all."""
    try:
        payload = json.loads(raw)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None
    if isinstance(payload, dict) and isinstance(payload.get("error"), str):
        return str(payload["error"])
    return None


def _parse_mint_response(payload: Any) -> MintCredentialResponse:
    if not isinstance(payload, dict):
        raise ValueError("control plane returned a malformed mint response")

    provider = str(payload.get("provider", ""))
    raw = payload.get("credentials")
    fields: Dict[str, Any] = raw if isinstance(raw, dict) else {}

    # Wire format is camelCase - it's produced by the control plane's
    # TypeScript (apps/control-plane/src/routes/credentials.ts).
    if provider == "aws":
        return MintCredentialResponse(
            provider=provider,
            credentials=MintedAWSCredentials(
                access_key_id=str(fields.get("accessKeyId", "")),
                secret_access_key=str(fields.get("secretAccessKey", "")),
                session_token=str(fields.get("sessionToken", "")),
                expiration=str(fields.get("expiration", "")),
            ),
        )

    if provider == "bitwarden":
        organization_id = fields.get("organizationId")
        return MintCredentialResponse(
            provider=provider,
            credentials=MintedBitwardenCredentials(
                access_token=str(fields.get("accessToken", "")),
                note=str(fields.get("note", "")),
                organization_id=str(organization_id) if organization_id else None,
            ),
        )

    return MintCredentialResponse(provider=provider)
