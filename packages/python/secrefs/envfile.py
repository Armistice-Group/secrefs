"""`.env` file parsing, kept at parity with the Node SDK's `envFile.ts`.

A naive line-based `.env` parser treats `#` as a start-of-comment marker
mid-value, which silently truncates the `#field` fragment off an unquoted
`sec://provider/path#field` reference - the exact format SecRefs itself
uses. This module strips inline comments the way `.env` conventionally
works (including on quoted values), then restores the untruncated value
for any unquoted `sec://` assignment, since there `#` is URI syntax, not a
comment marker.

Note: because of this, an unquoted `sec://` value can't have a trailing
inline comment on the same line - put comments on their own line instead.
Quoted values (`KEY="sec://...#field"`) are unaffected either way.
"""
from __future__ import annotations

import re
from typing import Dict

# Matches an *unquoted* `KEY=sec://...` assignment, capturing the rest of
# the line verbatim as the value.
_UNQUOTED_SEC_REF_LINE = re.compile(
    r"^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*(sec://\S.*)$"
)


def _strip_inline_comment(value: str) -> str:
    """Truncates an *unquoted* value at its first `#`, mirroring conventional
    `.env` comment handling (e.g. `dotenv`'s own default behavior)."""
    idx = value.find("#")
    if idx == -1:
        return value.rstrip()
    return value[:idx].rstrip()


def recover_truncated_sec_refs(raw_text: str, parsed: Dict[str, str]) -> Dict[str, str]:
    """Restores the full, untruncated value for any line that assigns an
    unquoted `sec://...` reference, undoing `_strip_inline_comment`'s
    truncation for exactly the cases where `#` is part of the URI rather
    than a comment marker."""
    result = dict(parsed)
    for line in re.split(r"\r?\n", raw_text):
        match = _UNQUOTED_SEC_REF_LINE.match(line)
        if not match:
            continue
        key, value = match.group(1), match.group(2)
        result[key] = value.rstrip()
    return result


def parse_env_file_text(raw_text: str) -> Dict[str, str]:
    """Parses a `.env` file's contents, correctly preserving
    `sec://...#field` fragments."""
    parsed: Dict[str, str] = {}

    for raw_line in raw_text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue

        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip()
        if not key:
            continue

        if value and value[0] in ("'", '"'):
            # A quoted value ends at its matching closing quote - anything
            # after that (typically a trailing comment) is discarded,
            # whether or not the quotes span the whole rest of the line.
            quote = value[0]
            end = value.find(quote, 1)
            value = value[1:end] if end != -1 else value[1:]
        else:
            value = _strip_inline_comment(value)

        parsed[key] = value

    return recover_truncated_sec_refs(raw_text, parsed)
