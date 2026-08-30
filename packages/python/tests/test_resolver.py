import json
import os
from typing import Dict, Union

import pytest

from secrefs.providers.base import ProviderHealth, SecretFetchRequest, SecretProvider
from secrefs.resolver import (
    SecRefsResolutionError,
    check_references,
    expand_environ,
    expand_key_value_map,
)


class FakeProvider(SecretProvider):
    name = "fake"

    def __init__(self, data: Dict[str, Union[Dict[str, str], str]]) -> None:
        self._data = data

    async def fetch_one(self, request: SecretFetchRequest) -> str:
        if request.path not in self._data:
            raise ValueError(f'no such path "{request.path}"')
        entry = self._data[request.path]

        if isinstance(entry, str):
            if request.field:
                raise ValueError(f'"{request.path}" is not an object, cannot extract field')
            return entry

        if not request.field:
            return json.dumps(entry)
        if request.field not in entry:
            raise ValueError(f'field "{request.field}" not found')
        return entry[request.field]

    async def health_check(self) -> ProviderHealth:
        return ProviderHealth(provider=self.name, ok=True)


@pytest.fixture
def providers():
    return {
        "fake": FakeProvider(
            {
                "prod/db": {"password": "hunter2", "user": "admin"},
                "simple-secret": "plain-value",
            }
        )
    }


async def test_leaves_non_reference_values_untouched(providers):
    result = await expand_key_value_map({"PORT": "3000"}, providers)
    assert result == {"PORT": "3000"}


async def test_resolves_a_reference_with_a_field(providers):
    result = await expand_key_value_map({"DB_PASSWORD": "sec://fake/prod/db#password"}, providers)
    assert result == {"DB_PASSWORD": "hunter2"}


async def test_resolves_a_plain_string_secret_without_a_field(providers):
    result = await expand_key_value_map({"API_KEY": "sec://fake/simple-secret"}, providers)
    assert result == {"API_KEY": "plain-value"}


async def test_resolves_multiple_references_concurrently(providers):
    result = await expand_key_value_map(
        {
            "DB_PASSWORD": "sec://fake/prod/db#password",
            "DB_USER": "sec://fake/prod/db#user",
            "PORT": "3000",
        },
        providers,
    )
    assert result == {"DB_PASSWORD": "hunter2", "DB_USER": "admin", "PORT": "3000"}


async def test_aggregates_all_failures_in_one_error(providers):
    with pytest.raises(SecRefsResolutionError) as exc_info:
        await expand_key_value_map(
            {
                "GOOD": "sec://fake/prod/db#password",
                "MISSING_PATH": "sec://fake/does-not-exist#x",
                "MISSING_FIELD": "sec://fake/prod/db#does-not-exist",
            },
            providers,
        )
    failed_keys = sorted(e.key for e in exc_info.value.errors)
    assert failed_keys == ["MISSING_FIELD", "MISSING_PATH"]


async def test_reports_unknown_provider_as_a_resolution_failure(providers):
    with pytest.raises(SecRefsResolutionError):
        await expand_key_value_map({"X": "sec://unknown/path#field"}, providers)


async def test_strict_mode_raises_immediately_on_malformed_refs(providers):
    with pytest.raises(Exception):
        await expand_key_value_map({"X": "sec://"}, providers, strict=True)


async def test_non_strict_mode_leaves_malformed_refs_untouched(providers):
    result = await expand_key_value_map({"X": "sec://"}, providers, strict=False)
    assert result == {"X": "sec://"}


async def test_expand_environ_mutates_os_environ_in_place(providers):
    os.environ["SECREFS_TEST_SECRET_REF"] = "sec://fake/prod/db#password"
    os.environ["SECREFS_TEST_PLAIN"] = "unchanged"
    try:
        changed = await expand_environ(providers)
        assert os.environ["SECREFS_TEST_SECRET_REF"] == "hunter2"
        assert os.environ["SECREFS_TEST_PLAIN"] == "unchanged"
        assert "SECREFS_TEST_SECRET_REF" in changed
        assert "SECREFS_TEST_PLAIN" not in changed
    finally:
        del os.environ["SECREFS_TEST_SECRET_REF"]
        del os.environ["SECREFS_TEST_PLAIN"]


async def test_check_references_reports_ok_without_leaking_values(providers):
    results = await check_references({"DB_PASSWORD": "sec://fake/prod/db#password"}, providers)
    assert len(results) == 1
    assert results[0].ok is True
    assert results[0].provider == "fake"
    assert "hunter2" not in json.dumps([r.__dict__ for r in results])


async def test_check_references_reports_failure_with_message(providers):
    results = await check_references({"DB_PASSWORD": "sec://fake/missing#password"}, providers)
    assert results[0].ok is False
    assert results[0].message


async def test_check_references_reports_malformed_refs_without_raising():
    results = await check_references({"X": "sec://"}, {})
    assert len(results) == 1
    assert results[0].provider == "unknown"
    assert results[0].ok is False


async def test_check_references_ignores_non_reference_values():
    results = await check_references({"PORT": "3000"}, {})
    assert results == []
