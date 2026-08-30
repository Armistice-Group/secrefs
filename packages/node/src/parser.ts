/**
 * URI parser for SecRefs' `sec://` reference format:
 *
 *   sec://<provider-alias>/<secret-path-or-id>[#<json-field>]
 *
 *   sec://aws/prod/db#password
 *   sec://vault/secret/data/stripe#key
 *   sec://local/mock-db#password
 *
 * The provider alias is a bare identifier (letters/digits/`-`/`_`), the path
 * is opaque to this parser (providers interpret it however their backend
 * needs), and the optional `#field` fragment supports dot-notation for
 * traversing nested JSON secrets (e.g. `#nested.value`).
 */

const SEC_REF_PATTERN = /^sec:\/\/([a-zA-Z0-9][a-zA-Z0-9_-]*)\/([^\s#]+)(?:#([^\s#]+))?$/;

export interface ParsedSecretRef {
  /** The original, unmodified reference string. */
  raw: string;
  /** Lowercased provider alias, e.g. "aws", "vault", "local". */
  provider: string;
  /** The secret path/id as understood by the provider. */
  path: string;
  /** Optional dot-notation field to extract from a JSON secret. */
  field?: string;
}

export class SecRefParseError extends Error {
  constructor(
    public readonly raw: string,
    public readonly reason: string,
  ) {
    super(`Invalid secret reference "${raw}": ${reason}`);
    this.name = "SecRefParseError";
  }
}

/** True if `value` is a string that looks like a `sec://` reference at all. */
export function isSecretRef(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("sec://");
}

/**
 * Parses a `sec://` reference string. Throws {@link SecRefParseError} if the
 * value isn't a string, doesn't start with `sec://`, or doesn't match the
 * full `<provider>/<path>[#field]` shape.
 */
export function parseSecretRef(raw: unknown): ParsedSecretRef {
  if (typeof raw !== "string") {
    throw new SecRefParseError(String(raw), "reference must be a string");
  }

  const trimmed = raw.trim();
  if (!trimmed.startsWith("sec://")) {
    throw new SecRefParseError(raw, 'must start with "sec://"');
  }

  const match = SEC_REF_PATTERN.exec(trimmed);
  if (!match) {
    throw new SecRefParseError(
      raw,
      "does not match sec://<provider>/<path>[#field] format",
    );
  }

  const [, provider, path, field] = match;
  if (!provider) {
    throw new SecRefParseError(raw, "missing provider alias");
  }
  if (!path) {
    throw new SecRefParseError(raw, "missing secret path");
  }

  return {
    raw,
    provider: provider.toLowerCase(),
    path,
    field: field || undefined,
  };
}

/** Best-effort parse that returns `null` instead of throwing. */
export function tryParseSecretRef(raw: unknown): ParsedSecretRef | null {
  try {
    return parseSecretRef(raw);
  } catch {
    return null;
  }
}
