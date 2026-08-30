/**
 * The provider contract every SecRefs backend (AWS, Vault, local, or a
 * custom one you bring yourself) implements. Providers never log, print,
 * or persist the values they return - that discipline is enforced by the
 * resolver and CLI layers above them, which only ever handle secret values
 * long enough to hand them to `process.env` or a spawned child process.
 */

export interface SecretFetchRequest {
  /** The provider-specific secret path/id, as written after `sec://<provider>/`. */
  path: string;
  /** Optional dot-notation field to extract from a JSON secret payload. */
  field?: string;
}

export interface ProviderHealth {
  provider: string;
  ok: boolean;
  /** Human-readable diagnostic. Never contains secret material. */
  message?: string;
}

export interface ISecretProvider {
  readonly name: string;

  /** Fetch and resolve a single secret reference to its final string value. */
  fetchOne(request: SecretFetchRequest): Promise<string>;

  /**
   * Fetch multiple secret references. Implementations may batch/dedupe
   * against the backend where possible; the default behavior (provided by
   * {@link BaseSecretProvider}) is concurrent individual fetches via
   * `Promise.allSettled`, surfacing the first failure with full context.
   */
  fetchBatch(requests: SecretFetchRequest[]): Promise<string[]>;

  /**
   * Lightweight reachability/auth probe used by `secrefs check`. Must never
   * throw for expected failure modes (bad credentials, unreachable host) -
   * those are reported via the returned {@link ProviderHealth}.
   */
  healthCheck(): Promise<ProviderHealth>;
}

export class SecretFetchError extends Error {
  constructor(
    public readonly provider: string,
    public readonly path: string,
    cause: unknown,
  ) {
    super(`[${provider}] failed to fetch secret at "${path}": ${errorMessage(cause)}`);
    this.name = "SecretFetchError";
  }
}

export abstract class BaseSecretProvider implements ISecretProvider {
  abstract readonly name: string;

  abstract fetchOne(request: SecretFetchRequest): Promise<string>;

  async fetchBatch(requests: SecretFetchRequest[]): Promise<string[]> {
    const settled = await Promise.allSettled(requests.map((r) => this.fetchOne(r)));
    return settled.map((result, i) => {
      const request = requests[i];
      if (result.status === "fulfilled") {
        return result.value;
      }
      throw new SecretFetchError(this.name, request?.path ?? "<unknown>", result.reason);
    });
  }

  abstract healthCheck(): Promise<ProviderHealth>;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Extracts a (possibly dot-nested) field from a JSON-encoded secret. If no
 * field is requested, the raw string is returned unchanged. Throws a plain
 * `Error` (never leaking the secret value itself) when the payload isn't
 * valid JSON or the field path doesn't resolve to a value.
 */
export function extractField(
  raw: string,
  field: string | undefined,
  context: { provider: string; path: string },
): string {
  if (!field) return raw;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `[${context.provider}] secret at "${context.path}" is not JSON, cannot extract field "${field}"`,
    );
  }

  let current: unknown = parsed;
  for (const part of field.split(".")) {
    if (current === null || typeof current !== "object") {
      throw new Error(
        `[${context.provider}] field "${field}" not found in secret at "${context.path}"`,
      );
    }
    current = (current as Record<string, unknown>)[part];
  }

  if (current === undefined) {
    throw new Error(
      `[${context.provider}] field "${field}" not found in secret at "${context.path}"`,
    );
  }

  return typeof current === "object" ? JSON.stringify(current) : String(current);
}
