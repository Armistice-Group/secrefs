import {
  GetSecretValueCommand,
  ListSecretsCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import {
  BaseSecretProvider,
  errorMessage,
  extractField,
  type ProviderHealth,
  type SecretFetchRequest,
} from "./base.js";
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
  private readonly rawCache = new Map<string, Promise<string>>();

  constructor(options: AwsProviderOptions = {}) {
    super();
    this.explicitClient = options.client;
    this.region = options.region;
    this.controlPlane = options.controlPlane;
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
    const cached = this.rawCache.get(path);
    if (cached) return cached;

    const pending = this.clientFor(path)
      .then((client) => client.send(new GetSecretValueCommand({ SecretId: path })))
      .then((response) => {
        if (typeof response.SecretString === "string") {
          return response.SecretString;
        }
        if (response.SecretBinary) {
          return Buffer.from(response.SecretBinary as Uint8Array).toString("utf8");
        }
        throw new Error(`secret "${path}" has no SecretString or SecretBinary payload`);
      })
      .catch((err: unknown) => {
        this.rawCache.delete(path);
        throw new Error(`could not fetch secret "${path}": ${errorMessage(err)}`);
      });

    this.rawCache.set(path, pending);
    return pending;
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
