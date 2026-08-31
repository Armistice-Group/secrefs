"""
Bitwarden **Secrets Manager** provider (not the password vault - see
https://bitwarden.com/help/secrets-manager-overview/). Two structural
differences from AWSSecretsManagerProvider/VaultProvider worth knowing
before using this:

1. **Secrets are end-to-end encrypted.** There is no plain authenticated
   REST call to fetch a value - the official SDK derives a decryption key
   from the access token during login and decrypts client-side. That's why
   this provider depends on `bitwarden-sdk` (Bitwarden's own Python binding
   over their Rust SDK) rather than a bare HTTP request.
2. **Bitwarden addresses secrets by UUID, with no path hierarchy** the way
   AWS/Vault secret names have. `path` may be that UUID directly, or - if
   `organization_id` is configured (ambient mode) or supplied by the control
   plane (control-plane mode) - a human-readable secret *name* (Bitwarden's
   "key" field), resolved via one cached `secrets().list()` call. With
   neither, only UUID paths work.

`bitwarden-sdk` is an optional dependency (`pip install 'secrefs[bitwarden]'`)
rather than a required one, unlike boto3 and hvac: it ships as prebuilt
native wheels for a fixed set of platform tags with no source distribution
to fall back on, so requiring it would break installing SecRefs at all on
any platform Bitwarden doesn't publish a wheel for - including for the
majority of users who never write a sec://bitwarden/... reference. It's
therefore imported at first use rather than at module import, so having a
BitwardenProvider in the default registry costs nothing until something
actually resolves through it.

The SDK is synchronous, so its calls are offloaded to a thread via
`asyncio.to_thread`, the same way boto3 and hvac calls are.
"""

from __future__ import annotations

import asyncio
import os
import re
from typing import Any, Dict, Optional

from ..control_plane_client import (
    ControlPlaneClient,
    ControlPlaneCredentialSource,
    MintedBitwardenCredentials,
)
from .base import ProviderHealth, SecretFetchRequest, SecretProvider, extract_field

UUID_PATTERN = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.IGNORECASE
)


def _unwrap(response: Any, context: str) -> Any:
    """Pulls `data` out of the SDK's `{success, data, errorMessage}` response
    envelope. The SDK itself already raises when `success` is false, so this
    is the belt to that's braces - but the envelope types `data` as optional,
    and an empty one would otherwise surface as an AttributeError rather than
    as whatever the SDK put in `errorMessage`."""
    data = getattr(response, "data", None)
    if data is None:
        message = getattr(response, "error_message", None) or "no data returned"
        raise ValueError(f"{context}: {message}")
    return data


class BitwardenProvider(SecretProvider):
    name = "bitwarden"

    def __init__(
        self,
        access_token: Optional[str] = None,
        organization_id: Optional[str] = None,
        api_url: Optional[str] = None,
        identity_url: Optional[str] = None,
        state_file: Optional[str] = None,
        control_plane: Optional[ControlPlaneCredentialSource] = None,
        client: Optional[Any] = None,
    ) -> None:
        """`access_token` defaults to $BWS_ACCESS_TOKEN and `organization_id`
        to $BWS_ORGANIZATION_ID; both are ignored when `control_plane` is
        set, which supplies them per request instead. `api_url`/
        `identity_url` (defaulting to $BWS_API_URL/$BWS_IDENTITY_URL) point
        at a self-hosted instance.

        `state_file` is an opt-in path to an encrypted session-state file the
        SDK can reuse across calls to reduce auth rate-limiting (Bitwarden's
        own docs describe this file's contents as fully encrypted, not
        plaintext secret material). Omitted by default - this provider
        authenticates in memory and writes nothing to disk unless a caller
        opts in.

        Setting `control_plane` sources the access token and organization id
        from a running control plane (docs/control-plane-design.md §7/§10,
        and §8 for why Bitwarden's distribution here isn't the same as AWS's
        per-request minting). Every fetch still requests a distribution for
        its specific `path`, so the control plane's RBAC Grant.path_pattern
        is enforced per secret even though the underlying Bitwarden token
        itself isn't scoped that narrowly - "SDK-side enforcement" as
        documented on the control-plane side."""
        self._explicit_client = client
        self._client_instance: Optional[Any] = None
        self._api_url = api_url or os.environ.get("BWS_API_URL")
        self._identity_url = identity_url or os.environ.get("BWS_IDENTITY_URL")
        self._state_file = state_file
        self._control_plane = control_plane
        self._control_plane_client: Optional[ControlPlaneClient] = None

        self._ambient_access_token: Optional[str] = None
        self._ambient_organization_id: Optional[str] = None
        self._organization_id: Optional[str] = None

        if control_plane is not None:
            self._control_plane_client = control_plane.client or ControlPlaneClient(
                base_url=control_plane.base_url, token=control_plane.token
            )
        else:
            self._ambient_access_token = access_token or os.environ.get("BWS_ACCESS_TOKEN")
            self._ambient_organization_id = organization_id or os.environ.get(
                "BWS_ORGANIZATION_ID"
            )
            self._organization_id = self._ambient_organization_id

        self._logged_in_token: Optional[str] = None
        # Secret name -> id, populated by one list() call the first time a
        # non-UUID path is requested. Dropped if organization_id ever changes
        # (control-plane mode, defensively - static in practice).
        self._name_to_id: Optional[Dict[str, str]] = None
        # Serializes login and the name->id lookup so N concurrent
        # expansions authenticate once and list once rather than N times.
        self._login_lock = asyncio.Lock()
        self._list_lock = asyncio.Lock()

    def _get_client(self) -> Any:
        if self._explicit_client is not None:
            return self._explicit_client
        if self._client_instance is not None:
            return self._client_instance

        try:
            from bitwarden_sdk import BitwardenClient, ClientSettings
        except ImportError as exc:
            raise ValueError(
                "the bitwarden-sdk package is required for sec://bitwarden/... references "
                "(pip install 'secrefs[bitwarden]') - Bitwarden secrets are end-to-end "
                "encrypted and can only be decrypted by their own SDK"
            ) from exc

        # Passing no settings at all when neither URL is overridden, rather
        # than a settings object full of Nones, so the SDK's own defaults
        # (bitwarden.com) stay the single source of that truth.
        if self._api_url or self._identity_url:
            self._client_instance = BitwardenClient(
                ClientSettings(api_url=self._api_url, identity_url=self._identity_url)
            )
        else:
            self._client_instance = BitwardenClient()
        return self._client_instance

    async def _login_with(self, access_token: str, organization_id: Optional[str]) -> None:
        async with self._login_lock:
            if organization_id != self._organization_id:
                self._name_to_id = None  # stale map keyed to a now-superseded org
                self._organization_id = organization_id
            if self._logged_in_token == access_token:
                return

            client = self._get_client()
            try:
                await asyncio.to_thread(
                    client.auth().login_access_token, access_token, self._state_file
                )
            except Exception as exc:  # noqa: BLE001 - re-raised with context below
                raise ValueError(
                    f"could not authenticate with the given access token: {exc}"
                ) from exc
            # Recorded only after a successful login, so a failure is retried
            # rather than remembered as a session that exists.
            self._logged_in_token = access_token

    async def _ensure_logged_in_for(self, path: str) -> None:
        """Ensures a session exists for `path`. Ambient mode logs in once
        with the ambient token; control-plane mode requests a distribution
        for this specific `path` every call - see the `control_plane`
        constructor argument for why that RBAC check has to be per-path even
        though the token it returns doesn't vary."""
        if self._control_plane is None or self._control_plane_client is None:
            if not self._ambient_access_token:
                raise ValueError(
                    "BWS_ACCESS_TOKEN is not set (required for sec://bitwarden/... references)"
                )
            await self._login_with(self._ambient_access_token, self._ambient_organization_id)
            return

        minted = await self._control_plane_client.mint_credential(self._control_plane.alias, path)
        credentials = minted.credentials
        if not isinstance(credentials, MintedBitwardenCredentials):
            raise ValueError(
                f'control plane returned a "{minted.provider}" credential for alias '
                f'"{self._control_plane.alias}", expected "bitwarden"'
            )
        await self._login_with(credentials.access_token, credentials.organization_id)

    async def _resolve_secret_id(self, path: str) -> str:
        """Assumes _ensure_logged_in_for(path) has already run for this exact
        `path` - callers always do that first, so self._organization_id is
        already whatever this path's session resolved to."""
        if UUID_PATTERN.match(path):
            return path

        if not self._organization_id:
            raise ValueError(
                f'"{path}" is not a secret UUID, and no organization_id is available to look up '
                "a secret by name (set BWS_ORGANIZATION_ID, use the UUID directly, or - in "
                "control-plane mode - the distributed credential didn't include one)"
            )

        async with self._list_lock:
            if self._name_to_id is None:
                organization_id = self._organization_id
                response = await asyncio.to_thread(
                    self._get_client().secrets().list, organization_id
                )
                listed = _unwrap(response, f'could not list secrets in "{organization_id}"')
                self._name_to_id = {secret.key: str(secret.id) for secret in listed.data}
            name_to_id = self._name_to_id

        secret_id = name_to_id.get(path)
        if secret_id is None:
            raise ValueError(
                f'no secret named "{path}" found in organization "{self._organization_id}"'
            )
        return secret_id

    async def fetch_one(self, request: SecretFetchRequest) -> str:
        try:
            # One _ensure_logged_in_for per fetch - in control-plane mode
            # this is the one distribution/RBAC-gate call for this path, and
            # _resolve_secret_id below relies on it having already set
            # self._organization_id.
            await self._ensure_logged_in_for(request.path)
            secret_id = await self._resolve_secret_id(request.path)
            response = await asyncio.to_thread(self._get_client().secrets().get, secret_id)
            secret = _unwrap(response, f'could not read secret "{request.path}"')
            value: str = secret.value
        except Exception as exc:  # noqa: BLE001 - re-raised with context below
            raise ValueError(f'could not fetch secret "{request.path}": {exc}') from exc

        # Deliberately outside the try: a missing #field is a reference
        # problem, not a fetch failure, and extract_field's message already
        # names the provider and path.
        return extract_field(value, request.field, provider=self.name, path=request.path)

    async def health_check(self) -> ProviderHealth:
        try:
            await self._ensure_logged_in_for("__secrefs_health_check__")
            return ProviderHealth(provider=self.name, ok=True)
        except Exception as exc:  # noqa: BLE001
            return ProviderHealth(provider=self.name, ok=False, message=str(exc))
