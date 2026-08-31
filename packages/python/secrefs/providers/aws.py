"""
AWS Secrets Manager provider. Two credential-sourcing modes:

- **Ambient (default)**: boto3's default credential resolution chain -
  environment variables, shared config/credentials files, ECS/EC2 instance
  metadata, or an assumed IAM role - so no credentials ever need to live in
  SecRefs configuration itself. One client is built lazily and reused for
  the provider's lifetime.
- **Control-plane-sourced** (`control_plane` option): a fresh,
  request-scoped credential is minted per fetch via the control plane's
  `/v1/credentials/mint`, so a distinct boto3 client is constructed per
  path rather than reused - each one only ever carries the narrow scope
  that one mint granted.

boto3 is synchronous, so calls are offloaded to a thread via
`asyncio.to_thread` to keep the async provider interface non-blocking.

The ambient client is constructed lazily on first use - boto3.client()
resolves (and validates) the region eagerly at construction time, raising
NoRegionError immediately if none is configured anywhere, so building it in
__init__ would mean simply having an AWSSecretsManagerProvider in your
registry - even one you never reference via sec://aws/... - breaks the
whole import in any region-less environment. Matches VaultProvider's own
lazy-construction rationale.

Fetched values are re-fetched on every expansion by default; see
`cache_ttl_ms` and ../ttl_cache.py for why that default is what it is.
"""

from __future__ import annotations

import asyncio
import os
from typing import Any, Optional, cast

import boto3

from ..control_plane_client import (
    ControlPlaneClient,
    ControlPlaneCredentialSource,
    ControlPlaneRequestError,
    MintedAWSCredentials,
)
from ..ttl_cache import TtlCache
from .base import ProviderHealth, SecretFetchRequest, SecretProvider, extract_field


class AWSSecretsManagerProvider(SecretProvider):
    name = "aws"

    def __init__(
        self,
        region: Optional[str] = None,
        client: Optional[Any] = None,
        control_plane: Optional[ControlPlaneCredentialSource] = None,
        cache_ttl_ms: float = 0.0,
    ) -> None:
        """`client` injects a pre-configured boto3 client (primarily for
        testing) and wins over `control_plane` if both are given, since a
        test that supplies an explicit client wants full control regardless
        of the mode. `cache_ttl_ms` is how long a fetched secret value may
        be reused; it defaults to 0, meaning every expansion re-fetches, so
        a rotated secret reaches a long-running consumer without a
        redeploy."""
        self._explicit_client = client
        self._client_instance: Optional[Any] = None
        self._region = region
        self._control_plane = control_plane
        self._control_plane_client: Optional[ControlPlaneClient] = None
        if control_plane is not None:
            self._control_plane_client = control_plane.client or ControlPlaneClient(
                base_url=control_plane.base_url, token=control_plane.token
            )
        self._raw_cache: TtlCache[str] = TtlCache(ttl_ms=cache_ttl_ms)

    def _region_name(self) -> Optional[str]:
        return self._region or os.environ.get("AWS_REGION")

    async def _client_for(self, path: str) -> Any:
        """Resolves the boto3 client to use for one `path` - lazily built and
        reused in ambient mode, freshly minted per call in control-plane
        mode. An explicitly injected client always wins."""
        if self._explicit_client is not None:
            return self._explicit_client

        if self._control_plane is not None and self._control_plane_client is not None:
            minted = await self._control_plane_client.mint_credential(
                self._control_plane.alias, path
            )
            credentials = minted.credentials
            if not isinstance(credentials, MintedAWSCredentials):
                raise ValueError(
                    f'control plane returned a "{minted.provider}" credential for alias '
                    f'"{self._control_plane.alias}", expected "aws"'
                )
            return boto3.client(
                "secretsmanager",
                region_name=self._region_name(),
                aws_access_key_id=credentials.access_key_id,
                aws_secret_access_key=credentials.secret_access_key,
                aws_session_token=credentials.session_token,
            )

        if self._client_instance is None:
            self._client_instance = boto3.client("secretsmanager", region_name=self._region_name())
        return self._client_instance

    async def _fetch_raw(self, path: str) -> str:
        try:
            client = await self._client_for(path)
            response = await asyncio.to_thread(client.get_secret_value, SecretId=path)
        except Exception as exc:  # noqa: BLE001 - re-raised with context below
            raise ValueError(f'could not fetch secret "{path}": {exc}') from exc

        if response.get("SecretString") is not None:
            return cast(str, response["SecretString"])
        if response.get("SecretBinary") is not None:
            raw = response["SecretBinary"]
            return raw.decode("utf-8") if isinstance(raw, (bytes, bytearray)) else str(raw)
        raise ValueError(f'secret "{path}" has no SecretString or SecretBinary payload')

    async def fetch_one(self, request: SecretFetchRequest) -> str:
        # Keyed by path, not by path+field, so several `#field` references
        # against the same secret still cost one call (and, in control-plane
        # mode, one mint) when they're expanded together.
        raw = await self._raw_cache.fetch(request.path, lambda: self._fetch_raw(request.path))
        return extract_field(raw, request.field, provider=self.name, path=request.path)

    async def health_check(self) -> ProviderHealth:
        try:
            if self._control_plane is not None and self._control_plane_client is not None:
                # A control-plane-sourced provider has no single ambient
                # credential to probe - health here means "the control plane
                # is reachable and this token is accepted", checked with a
                # deliberately-unresolvable synthetic path so this never
                # mutates anything or depends on any specific secret
                # existing. A 403 ("no grant authorizes...") still proves
                # reachability + auth worked; only a network/5xx failure
                # means unhealthy.
                try:
                    await self._control_plane_client.mint_credential(
                        self._control_plane.alias, "__secrefs_health_check__"
                    )
                except ControlPlaneRequestError:
                    return ProviderHealth(
                        provider=self.name, ok=True, message="control plane reachable"
                    )
                return ProviderHealth(provider=self.name, ok=True)

            # A cheap, low-privilege call that proves both network
            # reachability and that ambient credentials are valid.
            client = await self._client_for("__secrefs_health_check__")
            await asyncio.to_thread(client.list_secrets, MaxResults=1)
            return ProviderHealth(provider=self.name, ok=True)
        except Exception as exc:  # noqa: BLE001
            return ProviderHealth(provider=self.name, ok=False, message=str(exc))
