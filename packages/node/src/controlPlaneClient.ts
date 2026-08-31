/**
 * Thin HTTP client for a running control plane's credential-broker
 * endpoint (docs/control-plane-design.md §7). This is the piece §10
 * flagged as the missing link: every provider that supports
 * control-plane-sourced credentials (AwsSecretsManagerProvider,
 * BitwardenProvider - see their `controlPlane` constructor option)
 * constructs one of these instead of only ever reading ambient env vars.
 *
 * Deliberately just an HTTP wrapper with no retry/backoff/circuit-
 * breaking logic - a mint failure surfaces as a normal rejected promise,
 * same as any other provider fetch failure, and the caller's existing
 * error handling (resolver.ts's Promise.allSettled aggregation) already
 * does the right thing with that.
 */

export interface MintedAwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  /** ISO-8601 expiration timestamp. */
  expiration: string;
}

export interface MintedBitwardenCredentials {
  accessToken: string;
  organizationId?: string;
  /** Explicitly not a TTL promise - see apps/control-plane/src/providers/bitwarden.ts. */
  note: string;
}

export type MintCredentialResponse =
  | { provider: "aws"; credentials: MintedAwsCredentials }
  | { provider: "bitwarden"; credentials: MintedBitwardenCredentials };

/** What a provider's `controlPlane` constructor option needs - shared
 * shape between `AwsSecretsManagerProvider` and `BitwardenProvider` (and
 * any future control-plane-aware provider). */
export interface ControlPlaneCredentialSource {
  /** Base URL of a running control plane, e.g. from $SECREFS_CONTROL_PLANE_URL. */
  baseUrl: string;
  /** Bootstrap token or a verified OIDC token, e.g. from $SECREFS_CONTROL_PLANE_TOKEN. */
  token: string;
  /** Which `VaultConnection` alias this provider instance represents -
   * this is what the control plane's RBAC grants are actually scoped
   * against, not the `sec://` alias this provider happens to be
   * registered under (though in practice they're usually the same
   * string). */
  alias: string;
  /** Injected for testing - defaults to a real `ControlPlaneClient`. */
  client?: ControlPlaneClient;
}

export interface ControlPlaneClientOptions {
  /** Base URL of a running control plane, e.g. from $SECREFS_CONTROL_PLANE_URL. */
  baseUrl: string;
  /** Bootstrap token or a verified OIDC token, e.g. from $SECREFS_CONTROL_PLANE_TOKEN. */
  token: string;
  /** Injected for testing - defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/** Thrown for a well-formed error response from the control plane (401,
 * 403, 502, ...) - `status` and `message` come straight from its `{ error }`
 * body, so a denial reason (e.g. "no grant authorizes path...") reaches
 * the caller verbatim rather than as an opaque HTTP failure. */
export class ControlPlaneRequestError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ControlPlaneRequestError";
  }
}

export class ControlPlaneClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ControlPlaneClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** Authenticates, authorizes, and resolves a credential for `alias`/`path`
   * - see the control plane's `POST /v1/credentials/mint`. Throws
   * `ControlPlaneRequestError` for any non-2xx response. */
  async mintCredential(alias: string, path: string): Promise<MintCredentialResponse> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/v1/credentials/mint`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.token}` },
        body: JSON.stringify({ alias, path }),
      });
    } catch (err) {
      throw new Error(
        `could not reach control plane at ${this.baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      throw new ControlPlaneRequestError(
        response.status,
        body.error ?? `control plane returned ${response.status} for alias "${alias}" path "${path}"`,
      );
    }

    return (await response.json()) as MintCredentialResponse;
  }
}
