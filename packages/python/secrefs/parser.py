"""
URI parser for SecRefs' `sec://` reference format:

    sec://<provider-alias>/<secret-path-or-id>[#<json-field>]

    sec://aws/prod/db#password
    sec://vault/secret/data/stripe#key
    sec://local/mock-db#password

Mirrors packages/node/src/parser.ts exactly (same regex, same semantics),
so a `sec://` string means the same thing regardless of which SDK reads it.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Optional

_SEC_REF_PATTERN = re.compile(r"^sec://([a-zA-Z0-9][a-zA-Z0-9_-]*)/([^\s#]+)(?:#([^\s#]+))?$")


class SecRefParseError(ValueError):
    def __init__(self, raw: str, reason: str) -> None:
        self.raw = raw
        self.reason = reason
        super().__init__(f'Invalid secret reference "{raw}": {reason}')


@dataclass(frozen=True)
class ParsedSecretRef:
    raw: str
    provider: str
    path: str
    field: Optional[str] = None


def is_secret_ref(value: object) -> bool:
    """True if `value` is a string that looks like a `sec://` reference at all."""
    return isinstance(value, str) and value.startswith("sec://")


def parse_secret_ref(raw: object) -> ParsedSecretRef:
    """Parses a `sec://` reference string, raising SecRefParseError on any malformed input."""
    if not isinstance(raw, str):
        raise SecRefParseError(str(raw), "reference must be a string")

    trimmed = raw.strip()
    if not trimmed.startswith("sec://"):
        raise SecRefParseError(raw, 'must start with "sec://"')

    match = _SEC_REF_PATTERN.match(trimmed)
    if not match:
        raise SecRefParseError(raw, "does not match sec://<provider>/<path>[#field] format")

    provider, path, field = match.groups()
    if not provider:
        raise SecRefParseError(raw, "missing provider alias")
    if not path:
        raise SecRefParseError(raw, "missing secret path")

    return ParsedSecretRef(raw=raw, provider=provider.lower(), path=path, field=field or None)


def try_parse_secret_ref(raw: object) -> Optional[ParsedSecretRef]:
    """Best-effort parse that returns None instead of raising."""
    try:
        return parse_secret_ref(raw)
    except SecRefParseError:
        return None
