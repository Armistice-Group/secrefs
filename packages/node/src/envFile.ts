import { parse as parseDotenv } from "dotenv";

// Matches an *unquoted* `KEY=sec://...` assignment, capturing the rest of
// the line verbatim as the value.
const UNQUOTED_SEC_REF_LINE =
  /^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*(sec:\/\/\S.*)$/;

/**
 * dotenv treats `#` as a start-of-comment marker even mid-value (unless
 * the value is quoted), which silently truncates the `#field` fragment
 * off an unquoted `sec://provider/path#field` reference - the exact
 * format SecRefs itself uses. Rather than require every `sec://` value in
 * `.env` to be quoted (an easy thing to forget, with no error if you do),
 * this re-scans the raw file for unquoted `sec://` assignments and
 * restores the value dotenv would otherwise clip.
 *
 * Note: because of this, an unquoted `sec://` value can't have a
 * trailing inline comment on the same line - put comments on their own
 * line instead. Quoted values (`KEY="sec://...#field"`) are unaffected
 * and already handled correctly by dotenv itself.
 */
export function recoverTruncatedSecRefs(
  rawText: string,
  parsed: Record<string, string>,
): Record<string, string> {
  const result = { ...parsed };
  for (const line of rawText.split(/\r?\n/)) {
    const match = UNQUOTED_SEC_REF_LINE.exec(line);
    if (!match) continue;
    const [, key, value] = match;
    if (!key || value === undefined) continue;
    result[key] = value.trimEnd();
  }
  return result;
}

/** Parses a `.env` file's contents, correctly preserving `sec://...#field` fragments. */
export function parseEnvFileText(rawText: string): Record<string, string> {
  const parsed = parseDotenv(rawText);
  return recoverTruncatedSecRefs(rawText, parsed);
}
