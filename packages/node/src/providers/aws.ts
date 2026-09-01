import {
  GetSecretValueCommand,
  ListSecretsCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import {
  BaseSecretProvider,
  errorMessage,
  SecretFetchError,
  extractField,
  type ProviderHealth,
  type SecretFetchRequest,
} from "./base.js";
import { TtlCache } from "../ttlCache.js";
import { classifyError, isStaleServable } from "./errors.js";
import {
  ControlPlaneClient,
  ControlPlaneRequestError,
  type ControlPlaneCredentialSource,
  type MintedAwsCredentials,
} from "../controlPlaneClient.js";

export type { ControlPlaneCredentialSource };

export interface AwsProviderOptions {
  region?: string;
  /** Inject a pre-configured client (primarily for testing) - also wins
   * over `controlPlane` if both are set, since a test that supplies an
   * explicit client wants full control regardless of the mode. */
  client?: SecretsManagerClient;
  /**
   * Sources per-request AWS credentials from a running control plane
   * (docs/control-plane-design.md §7/§10) instead of the ambient default
   * credential chain. Every `fetchOne` call mints a fresh, request-scoped
   * credential via `sts:AssumeRole` on the control plane's side - see
   * `apps/control-plane/src/providers/awsSts.ts`. Mutually exclusive
   * with ambient auth in spirit (not enforced - `client` still wins if
   * both are given, for testing).
   */
  controlPlane?: ControlPlaneCredentialSource;
  /**
   * How long a fetched secret value may be reused, in milliseconds.
   * Defaults to 0 - every expansion re-fetches, so a rotated secret
   * reaches a long-running consumer without a redeploy. Raise it to
   * trade a bounded window of staleness for fewer round trips. See
   * ../ttlCache.ts.
   */
  cacheTtlMs?: number;
  /**
   * Milliseconds a previously-fetched value may be served after a *failed*
   * refresh. Defaults to 0 (off). Only ever applies to transient faults -
   * network, timeout, throttle, 5xx. An expired credential or a denial is
   * never answered from a stale value, because both mean something in the
   * environment changed that a human has to see. See ../ttlCache.ts.
   */
  staleGraceMs?: number;
  /** Called when a stale value is served, so a CLI can warn. Receives the
   * secret path and the age of the value - never the value. */
  onStaleValue?: (path: string, ageMs: number, err: unknown) => void;
}

/**
 * AWS Secrets Manager provider. Two credential-sourcing modes:
 *
 * - **Ambient (default)**: the AWS SDK v3 default credential provider
 *   chain - environment variables, shared config/credentials files,
 *   ECS/EC2 instance metadata, or an assumed IAM role. No credentials
 *   ever need to live in SecRefs configuration itself. One client is
 *   built lazily and reused for the provider's lifetime.
 * - **Control-plane-sourced** (`controlPlane` option): a fresh,
 *   request-scoped credential is minted per `fetchOne` call via the
 *   control plane's `/v1/credentials/mint`, so a distinct
 *   `SecretsManagerClient` is constructed per path rather than reused -
 *   each one only ever has the narrow scope that one mint granted.
 *
 * Raw secret values fetched per-path are cached in memory for the lifetime
 * of the provider instance either way, so multiple `#field` references
 * against the same secret only cost one API call (and, in control-plane
 * mode, one mint).
 */
export class AwsSecretsManagerProvider extends BaseSecretProvider {
  readonly name = "aws";

  private readonly explicitClient?: SecretsManagerClient;
  private readonly region?: string;
  private readonly controlPlane?: ControlPlaneCredentialSource;
  private readonly controlPlaneClient?: ControlPlaneClient;
  private ambientClient: SecretsManagerClient | null = null;
  private readonly rawCache: TtlCache<string>;

  constructor(options: AwsProviderOptions = {}) {
    super();
    this.explicitClient = options.client;
    this.region = options.region;
    this.controlPlane = options.controlPlane;
    this.rawCache = new TtlCache<string>({
      ttlMs: options.cacheTtlMs,
      staleGraceMs: options.staleGraceMs,
      isStaleServable: (err) => isStaleServable(classifyError(err)),
      onStale: options.onStaleValue,
    });
    if (this.controlPlane) {
      this.controlPlaneClient =
        this.controlPlane.client ??
        new ControlPlaneClient({ baseUrl: this.controlPlane.baseUrl, token: this.controlPlane.token });
    }
  }

  /** Resolves the `SecretsManagerClient` to use for one `path` - lazily
   * built and reused in ambient mode, freshly minted per call in
   * control-plane mode. `explicitClient` (test injection) always wins. */
  private async clientFor(path: string): Promise<SecretsManagerClient> {
    if (this.explicitClient) return this.explicitClient;

    if (this.controlPlane && this.controlPlaneClient) {
      const minted = await this.controlPlaneClient.mintCredential(this.controlPlane.alias, path);
      if (minted.provider !== "aws") {
        throw new Error(
          `control plane returned a "${minted.provider}" credential for alias "${this.controlPlane.alias}", ` +
            `expected "aws"`,
        );
      }
      return this.buildClientFromMintedCredentials(minted.credentials);
    }

    if (!this.ambientClient) this.ambientClient = new SecretsManagerClient({ region: this.region });
    return this.ambientClient;
  }

  private buildClientFromMintedCredentials(credentials: MintedAwsCredentials): SecretsManagerClient {
    return new SecretsManagerClient({
      region: this.region,
      credentials: {
        accessKeyId: credentials.accessKeyId,
        secretAccessKey: credentials.secretAccessKey,
        sessionToken: credentials.sessionToken,
      },
    });
  }

  private getRaw(path: string): Promise<string> {
    return this.rawCache.fetch(path, async () => {
      try {
        const client = await this.clientFor(path);
        const response = await client.send(new GetSecretValueCommand({ SecretId: path }));
        if (typeof response.SecretString === "string") {
          return response.SecretString;
        }
        if (response.SecretBinary) {
          return Buffer.from(response.SecretBinary as Uint8Array).toString("utf8");
        }
        throw new Error(`secret "${path}" has no SecretString or SecretBinary payload`);
      } catch (err) {
        // SecretFetchError, not a plain Error: it classifies the cause, so
        // an expired SSO session is reported as an auth failure with a
        // remedy rather than as four broken secrets.
        if (err instanceof SecretFetchError) throw err;
        throw new SecretFetchError(this.name, path, err);
      }
    });
  }

  async fetchOne(request: SecretFetchRequest): Promise<string> {
    const raw = await this.getRaw(request.path);
    return extractField(raw, request.field, { provider: this.name, path: request.path });
  }

  async healthCheck(): Promise<ProviderHealth> {
    try {
      if (this.controlPlane) {
        // A control-plane-sourced provider has no single ambient
        // credential to probe - health here means "the control plane is
        // reachable and this token is accepted", checked with a
        // deliberately-unresolvable synthetic path so this never mutates
        // anything or depends on any specific secret existing. A 403
        // ("no grant authorizes...") still proves reachability + auth
        // worked; only a network/5xx failure means unhealthy.
        const controlPlaneClient =
          this.controlPlane.client ??
          new ControlPlaneClient({ baseUrl: this.controlPlane.baseUrl, token: this.controlPlane.token });
        try {
          await controlPlaneClient.mintCredential(this.controlPlane.alias, "__secrefs_health_check__");
        } catch (err) {
          if (err instanceof ControlPlaneRequestError) {
            return { provider: this.name, ok: true, message: "control plane reachable" };
          }
          throw err;
        }
        return { provider: this.name, ok: true };
      }

      // A cheap, low-privilege call that proves both network reachability
      // and that the ambient credentials are valid enough to call the API.
      const client = await this.clientFor("__secrefs_health_check__");
      await client.send(new ListSecretsCommand({ MaxResults: 1 }));
      return { provider: this.name, ok: true };
    } catch (err) {
      return { provider: this.name, ok: false, message: errorMessage(err) };
    }
  }
}
