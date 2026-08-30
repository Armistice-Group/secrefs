from __future__ import annotations

import asyncio
import os
from dataclasses import dataclass
from typing import Dict, List, Mapping, Optional, Tuple

from .parser import ParsedSecretRef, is_secret_ref, parse_secret_ref
from .providers.base import SecretFetchRequest, SecretProvider

ProviderRegistry = Mapping[str, SecretProvider]


@dataclass(frozen=True)
class ResolutionFailure:
    key: str
    ref: str
    message: str


class SecRefsResolutionError(Exception):
    def __init__(self, errors: List[ResolutionFailure]) -> None:
        self.errors = errors
        lines = "\n".join(f"  - {e.key}: {e.ref} -> {e.message}" for e in errors)
        super().__init__(f"Failed to resolve {len(errors)} secret reference(s):\n{lines}")


@dataclass(frozen=True)
class CheckResult:
    key: str
    ref: str
    provider: str
    ok: bool
    message: Optional[str] = None  # present only when ok is False; never a secret value


async def _resolve_one(ref: ParsedSecretRef, providers: ProviderRegistry) -> str:
    provider = providers.get(ref.provider)
    if provider is None:
        available = ", ".join(providers.keys()) or "none configured"
        raise ValueError(f'unknown provider "{ref.provider}" (available: {available})')
    return await provider.fetch_one(SecretFetchRequest(path=ref.path, field=ref.field))


async def expand_key_value_map(
    input_map: Mapping[str, Optional[str]],
    providers: ProviderRegistry,
    *,
    strict: bool = True,
) -> Dict[str, str]:
    """
    Expands every `sec://` value in a plain key/value map, resolving all
    references concurrently. Non-reference values pass through untouched.
    Raises SecRefsResolutionError aggregating every failed reference.
    """
    output: Dict[str, str] = {}
    pending: List[Tuple[str, ParsedSecretRef]] = []

    for key, value in input_map.items():
        if value is None:
            continue
        if not is_secret_ref(value):
            output[key] = value
            continue
        try:
            pending.append((key, parse_secret_ref(value)))
        except ValueError:
            if strict:
                raise
            output[key] = value

    if not pending:
        return output

    results = await asyncio.gather(
        *(_resolve_one(ref, providers) for _, ref in pending), return_exceptions=True
    )

    errors: List[ResolutionFailure] = []
    for (key, ref), result in zip(pending, results):
        if isinstance(result, BaseException):
            errors.append(ResolutionFailure(key=key, ref=ref.raw, message=str(result)))
        else:
            output[key] = result

    if errors:
        raise SecRefsResolutionError(errors)

    return output


async def expand_environ(providers: ProviderRegistry, *, strict: bool = True) -> List[str]:
    """Expands sec:// values found in os.environ, mutating it in place."""
    resolved = await expand_key_value_map(dict(os.environ), providers, strict=strict)
    changed_keys: List[str] = []
    for key, value in resolved.items():
        if os.environ.get(key) != value:
            os.environ[key] = value
            changed_keys.append(key)
    return changed_keys


async def check_references(
    input_map: Mapping[str, Optional[str]], providers: ProviderRegistry
) -> List[CheckResult]:
    """
    Dry-run validation: resolves every sec:// reference in `input_map` but
    reports only ok/failure - secret values are never returned or logged.
    """
    results: List[CheckResult] = []
    parsed_entries: List[Tuple[str, ParsedSecretRef]] = []

    for key, value in input_map.items():
        if not isinstance(value, str) or not is_secret_ref(value):
            continue
        try:
            parsed_entries.append((key, parse_secret_ref(value)))
        except ValueError as exc:
            results.append(
                CheckResult(key=key, ref=value, provider="unknown", ok=False, message=str(exc))
            )

    outcomes = await asyncio.gather(
        *(_resolve_one(ref, providers) for _, ref in parsed_entries), return_exceptions=True
    )

    for (key, ref), outcome in zip(parsed_entries, outcomes):
        results.append(
            CheckResult(
                key=key,
                ref=ref.raw,
                provider=ref.provider,
                ok=not isinstance(outcome, BaseException),
                message=str(outcome) if isinstance(outcome, BaseException) else None,
            )
        )

    return results
