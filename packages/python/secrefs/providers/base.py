"""
The provider contract every SecRefs backend implements. Providers never
log, print, or persist the values they return - that discipline is
enforced by the resolver/CLI layers above them.
"""

from __future__ import annotations

import asyncio
import json
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any, List, Optional

_MISSING = object()


@dataclass(frozen=True)
class SecretFetchRequest:
    path: str
    field: Optional[str] = None


@dataclass(frozen=True)
class ProviderHealth:
    provider: str
    ok: bool
    message: Optional[str] = None  # human-readable diagnostic; never secret material


class SecretFetchError(Exception):
    def __init__(self, provider: str, path: str, cause: object) -> None:
        self.provider = provider
        self.path = path
        super().__init__(f'[{provider}] failed to fetch secret at "{path}": {cause}')


class SecretProvider(ABC):
    name: str

    @abstractmethod
    async def fetch_one(self, request: SecretFetchRequest) -> str: ...

    async def fetch_batch(self, requests: List[SecretFetchRequest]) -> List[str]:
        """
        Default implementation: concurrent individual fetches, surfacing the
        first failure with full context. Providers may override this to use
        a backend's native batch API.
        """
        results = await asyncio.gather(
            *(self.fetch_one(r) for r in requests), return_exceptions=True
        )
        values: List[str] = []
        for request, result in zip(requests, results):
            if isinstance(result, BaseException):
                raise SecretFetchError(self.name, request.path, result) from result
            values.append(result)
        return values

    @abstractmethod
    async def health_check(self) -> ProviderHealth: ...


def extract_field(raw: str, field: Optional[str], *, provider: str, path: str) -> str:
    """
    Extracts a (possibly dot-nested) field from a JSON-encoded secret. If no
    field is requested, `raw` is returned unchanged.
    """
    if not field:
        return raw

    try:
        parsed: Any = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError(
            f'[{provider}] secret at "{path}" is not JSON, cannot extract field "{field}"'
        ) from exc

    current: Any = parsed
    for part in field.split("."):
        if not isinstance(current, dict):
            raise ValueError(f'[{provider}] field "{field}" not found in secret at "{path}"')
        current = current.get(part, _MISSING)
        if current is _MISSING:
            raise ValueError(f'[{provider}] field "{field}" not found in secret at "{path}"')

    if isinstance(current, (dict, list)):
        return json.dumps(current)
    return str(current)
