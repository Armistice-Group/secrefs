"""
AWS Secrets Manager provider. Uses boto3's default credential resolution
chain - environment variables, shared config/credentials files, ECS/EC2
instance metadata, or an assumed IAM role - so no credentials ever need to
live in SecRefs configuration itself.

boto3 is synchronous, so calls are offloaded to a thread via
`asyncio.to_thread` to keep the async provider interface non-blocking.
"""

from __future__ import annotations

import asyncio
import os
from typing import Any, Dict, Optional, cast

import boto3

from .base import ProviderHealth, SecretFetchRequest, SecretProvider, extract_field


class AWSSecretsManagerProvider(SecretProvider):
    name = "aws"

    def __init__(self, region: Optional[str] = None, client: Optional[Any] = None) -> None:
        self._client = client or boto3.client(
            "secretsmanager", region_name=region or os.environ.get("AWS_REGION")
        )
        self._raw_cache: Dict[str, "asyncio.Task[str]"] = {}

    def _get_raw(self, path: str) -> "asyncio.Task[str]":
        task = self._raw_cache.get(path)
        if task is None:
            task = asyncio.ensure_future(self._fetch_raw(path))
            self._raw_cache[path] = task
        return task

    async def _fetch_raw(self, path: str) -> str:
        try:
            response = await asyncio.to_thread(self._client.get_secret_value, SecretId=path)
        except Exception as exc:  # noqa: BLE001 - re-raised with context below
            self._raw_cache.pop(path, None)
            raise ValueError(f'could not fetch secret "{path}": {exc}') from exc

        if response.get("SecretString") is not None:
            return cast(str, response["SecretString"])
        if response.get("SecretBinary") is not None:
            raw = response["SecretBinary"]
            return raw.decode("utf-8") if isinstance(raw, (bytes, bytearray)) else str(raw)
        raise ValueError(f'secret "{path}" has no SecretString or SecretBinary payload')

    async def fetch_one(self, request: SecretFetchRequest) -> str:
        raw = await self._get_raw(request.path)
        return extract_field(raw, request.field, provider=self.name, path=request.path)

    async def health_check(self) -> ProviderHealth:
        try:
            # A cheap, low-privilege call that proves both network
            # reachability and that ambient credentials are valid.
            await asyncio.to_thread(self._client.list_secrets, MaxResults=1)
            return ProviderHealth(provider=self.name, ok=True)
        except Exception as exc:  # noqa: BLE001
            return ProviderHealth(provider=self.name, ok=False, message=str(exc))
