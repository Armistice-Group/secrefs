import pytest

from secrefs.parser import (
    SecRefParseError,
    is_secret_ref,
    parse_secret_ref,
    try_parse_secret_ref,
)


def test_parses_simple_aws_reference_with_field():
    ref = parse_secret_ref("sec://aws/prod/db#password")
    assert ref.provider == "aws"
    assert ref.path == "prod/db"
    assert ref.field == "password"
    assert ref.raw == "sec://aws/prod/db#password"


def test_parses_vault_kv_v2_style_reference():
    ref = parse_secret_ref("sec://vault/secret/data/stripe#key")
    assert ref.provider == "vault"
    assert ref.path == "secret/data/stripe"
    assert ref.field == "key"


def test_parses_local_reference():
    ref = parse_secret_ref("sec://local/mock-db#password")
    assert ref.provider == "local"
    assert ref.path == "mock-db"
    assert ref.field == "password"


def test_supports_references_without_a_field_fragment():
    ref = parse_secret_ref("sec://aws/prod/api-key")
    assert ref.field is None
    assert ref.path == "prod/api-key"


def test_supports_dotted_nested_field_paths():
    ref = parse_secret_ref("sec://vault/secret/data/stripe#nested.value")
    assert ref.field == "nested.value"


def test_lowercases_the_provider_alias():
    ref = parse_secret_ref("sec://AWS/prod/db#password")
    assert ref.provider == "aws"


def test_trims_surrounding_whitespace():
    ref = parse_secret_ref("  sec://aws/prod/db#password  ")
    assert ref.provider == "aws"


@pytest.mark.parametrize(
    "raw",
    [
        "env://aws/prod/db",
        "sec:///prod/db",
        "sec://aws",
        "sec://aws/prod db#password",
    ],
)
def test_rejects_malformed_references(raw):
    with pytest.raises(SecRefParseError):
        parse_secret_ref(raw)


def test_rejects_non_string_input():
    with pytest.raises(SecRefParseError):
        parse_secret_ref(1234)


def test_error_carries_raw_value_and_reason():
    with pytest.raises(SecRefParseError) as exc_info:
        parse_secret_ref("sec://aws")
    assert exc_info.value.raw == "sec://aws"
    assert "path" in exc_info.value.reason


def test_try_parse_returns_parsed_ref_on_success():
    ref = try_parse_secret_ref("sec://aws/prod/db#password")
    assert ref is not None
    assert ref.provider == "aws"


def test_try_parse_returns_none_on_failure():
    assert try_parse_secret_ref("not-a-ref") is None


def test_is_secret_ref():
    assert is_secret_ref("sec://aws/prod/db#password") is True
    assert is_secret_ref("just-a-value") is False
    assert is_secret_ref(None) is False
    assert is_secret_ref(42) is False
