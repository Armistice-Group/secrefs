"""
Reads secrets from a gitignored, developer-local JSON file. Intended for
local development only.

Example `.secrefs.local.json`:
    { "mock-db": { "password": "hunter2", "user": "postgres" } }
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Dict, Optional, Union

from .base import ProviderHealth, SecretFetchRequest, SecretProvider, extract_field

DEFAULT_FILENAME = ".secrefs.local.json"


class LocalProvider(SecretProvider):
    name = "local"

    def __init__(
        self,
        file_path: Optional[Union[str, Path]] = None,
        cache_file: bool = False,
    ) -> None:
        """`cache_file` keeps the parsed file in memory instead of re-reading
        it per fetch. Off by default so an edit takes effect immediately -
        caching it meant editing .secrefs.local.json mid-session silently did
        nothing, which is the local-development shape of the same
        stale-secret problem ../ttl_cache.py exists to solve."""
        self._file_path = Path(
            file_path or os.environ.get("SECREFS_LOCAL_FILE") or (Path.cwd() / DEFAULT_FILENAME)
        )
        self._cache_file = cache_file
        self._cache: Optional[Dict[str, Any]] = None

    def _load(self) -> Dict[str, Any]:
        # The file is local and tiny, so re-reading it costs nothing worth
        # trading an edit-takes-effect guarantee for.
        if self._cache is not None and self._cache_file:
            return self._cache

        try:
            raw = self._file_path.read_text(encoding="utf-8")
        except OSError as exc:
            raise ValueError(
                f'[local] could not read local secrets file at "{self._file_path}": {exc}. '
                "This file is gitignored by convention - see .secrefs.local.json in .gitignore."
            ) from exc

        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise ValueError(f'[local] "{self._file_path}" is not valid JSON: {exc}') from exc

        if not isinstance(parsed, dict):
            raise ValueError(f'[local] "{self._file_path}" must contain a top-level JSON object')

        self._cache = parsed
        return self._cache

    async def fetch_one(self, request: SecretFetchRequest) -> str:
        data = self._load()
        if request.path not in data:
            raise ValueError(f'[local] no entry for path "{request.path}" in {self._file_path}')

        entry = data[request.path]
        raw = entry if isinstance(entry, str) else json.dumps(entry)
        return extract_field(raw, request.field, provider=self.name, path=request.path)

    async def health_check(self) -> ProviderHealth:
        try:
            self._load()
            return ProviderHealth(provider=self.name, ok=True, message=str(self._file_path))
        except Exception as exc:  # noqa: BLE001 - surfaced to the caller as a health message
            return ProviderHealth(provider=self.name, ok=False, message=str(exc))
