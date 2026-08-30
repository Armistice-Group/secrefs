from secrefs.envfile import parse_env_file_text, recover_truncated_sec_refs


class TestParseEnvFileText:
    def test_preserves_field_fragment_on_unquoted_sec_ref(self):
        parsed = parse_env_file_text("DB_PASSWORD=sec://aws/prod/db#password\n")
        assert parsed["DB_PASSWORD"] == "sec://aws/prod/db#password"

    def test_preserves_field_fragment_on_quoted_sec_ref(self):
        parsed = parse_env_file_text('DB_PASSWORD="sec://aws/prod/db#password"\n')
        assert parsed["DB_PASSWORD"] == "sec://aws/prod/db#password"

    def test_treats_standalone_comment_line_as_comment(self):
        parsed = parse_env_file_text("# this is a real comment\nPORT=3000\n")
        assert parsed == {"PORT": "3000"}

    def test_strips_inline_comment_on_ordinary_unquoted_value(self):
        parsed = parse_env_file_text("GREETING=hello # trailing comment\n")
        assert parsed["GREETING"] == "hello"

    def test_strips_inline_comment_on_ordinary_quoted_value(self):
        # Regression: the previous CLI-embedded loader kept the closing quote
        # check strict, so a trailing comment after a quoted value fell
        # through unstripped, quotes and all - e.g. `"sec://..." # note`
        # was assigned verbatim, quotes included, and never even recognized
        # as a sec:// reference since it no longer started with "sec://".
        parsed = parse_env_file_text('GREETING="hello" # trailing comment\n')
        assert parsed["GREETING"] == "hello"

    def test_strips_inline_comment_after_quoted_sec_ref(self):
        parsed = parse_env_file_text(
            'DB_PASSWORD="sec://aws/prod/db#password" # inline note\n'
        )
        assert parsed["DB_PASSWORD"] == "sec://aws/prod/db#password"

    def test_handles_multiple_refs_and_plain_values_in_same_file(self):
        parsed = parse_env_file_text(
            "\n".join(
                [
                    "PORT=3000",
                    "DB_PASSWORD=sec://aws/prod/db#password",
                    "STRIPE_KEY=sec://vault/secret/data/stripe#key",
                    "PLAIN=just-a-value",
                ]
            )
        )
        assert parsed == {
            "PORT": "3000",
            "DB_PASSWORD": "sec://aws/prod/db#password",
            "STRIPE_KEY": "sec://vault/secret/data/stripe#key",
            "PLAIN": "just-a-value",
        }

    def test_supports_leading_export_keyword_before_sec_ref(self):
        parsed = parse_env_file_text("export DB_PASSWORD=sec://aws/prod/db#password\n")
        assert parsed["DB_PASSWORD"] == "sec://aws/prod/db#password"

    def test_supports_dotted_nested_field_fragments(self):
        parsed = parse_env_file_text("X=sec://vault/secret/data/stripe#nested.value\n")
        assert parsed["X"] == "sec://vault/secret/data/stripe#nested.value"


class TestRecoverTruncatedSecRefs:
    def test_only_overrides_keys_whose_raw_line_is_unquoted_sec_ref(self):
        parsed = {"A": "sec://aws/x", "B": "unrelated"}
        result = recover_truncated_sec_refs("A=sec://aws/x#field\nB=unrelated\n", parsed)
        assert result == {"A": "sec://aws/x#field", "B": "unrelated"}
