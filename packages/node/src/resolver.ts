import { type ParsedSecretRef, isSecretRef, parseSecretRef } from "./parser.js";
import { errorMessage, type ISecretProvider, type SecretFetchRequest } from "./providers/base.js";

export type ProviderRegistry = Record<string, ISecretProvider>;

export interface ExpandOptions {
  providers: ProviderRegistry;
  /**
   * When true (default), a value that starts with `sec://` but fails to
   * parse throws immediately. When false, such values are left untouched.
   * This only affects syntactically malformed references - unknown
   * providers and provider-side fetch failures always surface as errors,
   * aggregated in a {@link SecRefsResolutionError}.
   */
  strict?: boolean;
}

export interface ResolutionFailure {
  /** The env var / map key the reference was assigned to. */
  key: string;
  /** The original `sec://` string. */
  ref: string;
  message: string;
}

export class SecRefsResolutionError extends Error {
  constructor(public readonly errors: ResolutionFailure[]) {
    super(
      `Failed to resolve ${errors.length} secret reference(s):\n` +
        errors.map((e) => `  - ${e.key}: ${e.ref} -> ${e.message}`).join("\n"),
    );
    this.name = "SecRefsResolutionError";
  }
}

export interface CheckResult {
  key: string;
  ref: string;
  provider: string;
  ok: boolean;
  /** Present only when ok is false. Never contains the secret value. */
  message?: string;
}

async function resolveOne(
  ref: ParsedSecretRef,
  providers: ProviderRegistry,
): Promise<string> {
  const provider = providers[ref.provider];
  if (!provider) {
    const available = Object.keys(providers).join(", ") || "none configured";
    throw new Error(`unknown provider "${ref.provider}" (available: ${available})`);
  }
  const request: SecretFetchRequest = { path: ref.path, field: ref.field };
  return provider.fetchOne(request);
}

/**
 * Expands every `sec://` value in a plain key/value map, resolving all
 * references concurrently via `Promise.allSettled`. Non-reference values
 * pass through untouched. Never writes anything to disk - the caller
 * decides what to do with the returned map (assign to `process.env`,
 * template into a string, etc).
 *
 * Throws {@link SecRefsResolutionError} aggregating every failed
 * reference if any fail to resolve.
 */
export async function expandKeyValueMap(
  input: Record<string, string | undefined>,
  options: ExpandOptions,
): Promise<Record<string, string>> {
  const strict = options.strict ?? true;
  const output: Record<string, string> = {};
  const pending: { key: string; ref: ParsedSecretRef }[] = [];

  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if (!isSecretRef(value)) {
      output[key] = value;
      continue;
    }
    try {
      pending.push({ key, ref: parseSecretRef(value) });
    } catch (err) {
      if (strict) throw err;
      output[key] = value;
    }
  }

  if (pending.length === 0) {
    return output;
  }

  const settled = await Promise.allSettled(
    pending.map(({ ref }) => resolveOne(ref, options.providers)),
  );

  const errors: ResolutionFailure[] = [];
  settled.forEach((result, i) => {
    const { key, ref } = pending[i] as { key: string; ref: ParsedSecretRef };
    if (result.status === "fulfilled") {
      output[key] = result.value;
    } else {
      errors.push({ key, ref: ref.raw, message: errorMessage(result.reason) });
    }
  });

  if (errors.length > 0) {
    throw new SecRefsResolutionError(errors);
  }

  return output;
}

/**
 * Expands `sec://` values found in `process.env`, mutating it in place.
 * Returns the list of env var names that were rewritten.
 */
export async function expandProcessEnv(options: ExpandOptions): Promise<string[]> {
  const resolved = await expandKeyValueMap(process.env, options);
  const changedKeys: string[] = [];
  for (const [key, value] of Object.entries(resolved)) {
    if (process.env[key] !== value) {
      process.env[key] = value;
      changedKeys.push(key);
    }
  }
  return changedKeys;
}

/**
 * Dry-run validation: resolves every `sec://` reference found in `input`
 * but reports only ok/failure per reference - the secret values themselves
 * are never returned or logged. Used by `secrefs check`.
 */
export async function checkReferences(
  input: Record<string, string | undefined>,
  options: ExpandOptions,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const parsedEntries: { key: string; ref: ParsedSecretRef }[] = [];

  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || !isSecretRef(value)) continue;
    try {
      parsedEntries.push({ key, ref: parseSecretRef(value) });
    } catch (err) {
      results.push({ key, ref: value, provider: "unknown", ok: false, message: errorMessage(err) });
    }
  }

  const settled = await Promise.allSettled(
    parsedEntries.map(({ ref }) => resolveOne(ref, options.providers)),
  );

  settled.forEach((result, i) => {
    const { key, ref } = parsedEntries[i] as { key: string; ref: ParsedSecretRef };
    results.push({
      key,
      ref: ref.raw,
      provider: ref.provider,
      ok: result.status === "fulfilled",
      message: result.status === "rejected" ? errorMessage(result.reason) : undefined,
    });
  });

  return results;
}
