import json

import pytest

from secrefs.providers.base import SecretFetchRequest
from secrefs.providers.local import LocalProvider


@pytest.fixture
def local_file(tmp_path):
    path = tmp_path / ".secrefs.local.json"
    path.write_text(json.dumps({"mock-db": {"password": "hunter2"}}), encoding="utf-8")
    return path


async def test_reads_a_field_out_of_the_local_file(local_file):
    provider = LocalProvider(file_path=local_file)

    value = await provider.fetch_one(SecretFetchRequest(path="mock-db", field="password"))

    assert value == "hunter2"


async def test_rereads_the_file_so_a_mid_session_edit_takes_effect(local_file):
    provider = LocalProvider(file_path=local_file)
    assert await provider.fetch_one(SecretFetchRequest(path="mock-db", field="password")) == "hunter2"

    local_file.write_text(json.dumps({"mock-db": {"password": "rotated"}}), encoding="utf-8")

    # Caching the parsed file meant editing it mid-session silently did
    # nothing - the local-development shape of the stale-secret problem.
    assert await provider.fetch_one(SecretFetchRequest(path="mock-db", field="password")) == "rotated"


async def test_cache_file_opts_back_into_holding_the_parsed_file(local_file):
    provider = LocalProvider(file_path=local_file, cache_file=True)
    await provider.fetch_one(SecretFetchRequest(path="mock-db", field="password"))

    local_file.write_text(json.dumps({"mock-db": {"password": "rotated"}}), encoding="utf-8")

    assert await provider.fetch_one(SecretFetchRequest(path="mock-db", field="password")) == "hunter2"


async def test_reports_a_missing_path(local_file):
    provider = LocalProvider(file_path=local_file)

    with pytest.raises(ValueError, match='no entry for path "nope"'):
        await provider.fetch_one(SecretFetchRequest(path="nope"))


async def test_health_check_reports_the_file_it_read(local_file):
    provider = LocalProvider(file_path=local_file)

    health = await provider.health_check()

    assert health.ok is True
    assert health.message == str(local_file)
