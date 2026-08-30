"""
HashiCorp Vault provider supporting both KV v1 and KV v2 secrets engines.
Auth is ambient via VAULT_ADDR/VAULT_TOKEN - point `path` at whatever the
Vault HTTP API itself expects (KV v2 mounts include a literal `data/`
segment, e.g. `secret/data/stripe`; KV v1 mounts do not).

hvac is synchronous, so calls are offloaded to a thread via
`asyncio.to_thread`. The client is constructed lazily on first use so that
simply having a VaultProvider in your registry doesn't require Vault to be
configured if you never reference sec://vault/... at all.
"""

from __future__ import annotations

import asyncio
import json
import os
from typing import Any, Dict, Optional, cast

import hvac

from .base import ProviderHealth, SecretFetchRequest, SecretProvider, extract_field


class VaultProvider(SecretProvider):
    name = "vault"

    def __init__(
        self,
        url: Optional[str] = None,
        token: Optional[str] = None,
        client: Optional[Any] = None,
    ) -> None:
        self._explicit_client = client
        self._url = url or os.environ.get("VAULT_ADDR")
        self._token = token or os.environ.get("VAULT_TOKEN")
        self._client_instance: Optional[Any] = None
        self._data_cache: Dict[str, "asyncio.Task[Dict[str, Any]]"] = {}

    def _get_client(self) -> Any:
        if self._explicit_client is not None:
            return self._explicit_client
        if self._client_instance is not None:
            return self._client_instance

        if not self._url:
            raise ValueError("VAULT_ADDR is not set (required for sec://vault/... references)")
        if not self._token:
            raise ValueError("VAULT_TOKEN is not set (required for sec://vault/... references)")

        self._client_instance = hvac.Client(url=self._url, token=self._token)
        return self._client_instance

    def _get_data(self, path: str) -> "asyncio.Task[Dict[str, Any]]":
        task = self._data_cache.get(path)
        if task is None:
            task = asyncio.ensure_future(self._fetch_data(path))
            self._data_cache[path] = task
        return task

    async def _fetch_data(self, path: str) -> Dict[str, Any]:
        client = self._get_client()
        try:
            response = await asyncio.to_thread(client.read, path)
        except Exception as exc:  # noqa: BLE001
            self._data_cache.pop(path, None)
            raise ValueError(f'could not read Vault path "{path}": {exc}') from exc

        if response is None or "data" not in response:
            raise ValueError(f'no data returned for path "{path}"')

        outer = response["data"]
        # KV v2 responses nest the secret under data.data alongside
        # data.metadata; KV v1 responses put the secret straight in data.
        if isinstance(outer, dict) and "data" in outer and "metadata" in outer:
            return cast(Dict[str, Any], outer["data"])
        return cast(Dict[str, Any], outer)

    async def fetch_one(self, request: SecretFetchRequest) -> str:
        data = await self._get_data(request.path)

        if not request.field:
            if len(data) == 1:
                (only,) = data.values()
                return only if isinstance(only, str) else json.dumps(only)
            return json.dumps(data)

        return extract_field(json.dumps(data), request.field, provider=self.name, path=request.path)

    async def health_check(self) -> ProviderHealth:
        try:
            client = self._get_client()
            await asyncio.to_thread(client.sys.read_health_status)
            return ProviderHealth(provider=self.name, ok=True)
        except Exception as exc:  # noqa: BLE001
            return ProviderHealth(provider=self.name, ok=False, message=str(exc))
