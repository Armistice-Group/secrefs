import { BitwardenClient } from "@bitwarden/sdk-napi";
import {
  BaseSecretProvider,
  errorMessage,
  extractField,
  type ProviderHealth,
  type SecretFetchRequest,
} from "./base.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The subset of `@bitwarden/sdk-napi`'s `BitwardenClient` this provider
 * calls - kept narrow so tests can inject a plain mock object instead of
 * a real client, the same pattern `VaultProvider`/`AwsSecretsManagerProvider`
 * use for their own SDK clients. */
export interface BitwardenClientLike {
  auth(): { loginAccessToken(accessToken: string, stateFile?: string): Promise<void> };
  secrets(): {
    get(id: string): Promise<{ value: string }>;
    list(organizationId: string): Promise<{ data: { id: string; key: string }[] }>;
  };
}

export interface BitwardenProviderOptions {
  /** Defaults to $BWS_ACCESS_TOKEN. */
  accessToken?: string;
  /** Required only to resolve a `path` given as a secret *name* rather
   * than its UUID (see class docs). Defaults to $BWS_ORGANIZATION_ID. */
  organizationId?: string;
  /** Self-hosted instance override. Defaults to $BWS_API_URL. */
  apiUrl?: string;
  /** Self-hosted instance override. Defaults to $BWS_IDENTITY_URL. */
  identityUrl?: string;
  /**
   * Opt-in path to an encrypted session-state file the SDK can reuse
   * across calls to reduce auth rate-limiting (Bitwarden's own docs
   * describe this file's contents as fully encrypted, not plaintext
   * secret material). Omitted by default - this provider re-authenticates
   * in memory each time it's constructed and writes nothing to disk
   * unless a caller opts in.
   */
  stateFile?: string;
  /** Inject a pre-configured client (primarily for testing). */
  client?: BitwardenClientLike;
}

/**
 * Bitwarden **Secrets Manager** provider (not the password vault - see
 * https://bitwarden.com/help/secrets-manager-overview/). Two structural
 * differences from `AwsSecretsManagerProvider`/`VaultProvider` worth
 * knowing before using this:
 *
 * 1. **Secrets are end-to-end encrypted.** There is no plain authenticated
 *    REST call to fetch a value - the official SDK derives a decryption
 *    key from the access token during login and decrypts client-side.
 *    That's why this provider depends on `@bitwarden/sdk-napi` (a beta
 *    Node-API binding maintained by Bitwarden) rather than a bare `fetch`.
 * 2. **Bitwarden addresses secrets by UUID, with no path hierarchy** the
 *    way AWS/Vault secret names have. `path` may be that UUID directly, or
 *    - if `organizationId` is configured - a human-readable secret *name*
 *    (Bitwarden's "key" field), resolved via one cached `secrets().list()`
 *    call. Without `organizationId`, only UUID paths work.
 *
 * See docs/control-plane-design.md §8 for how this fits (or doesn't yet)
 * into the control plane's credential-broker model - Bitwarden access
 * tokens are pre-provisioned per machine account, not dynamically
 * re-scoped per request the way AWS/GCP credentials are.
 */
export class BitwardenProvider extends BaseSecretProvider {
  readonly name = "bitwarden";

  private readonly explicitClient?: BitwardenClientLike;
  private readonly accessToken?: string;
  private readonly organizationId?: string;
  private readonly apiUrl?: string;
  private readonly identityUrl?: string;
  private readonly stateFile?: string;

  private client: BitwardenClientLike | null = null;
  private loggedIn: Promise<void> | null = null;
  /** Secret name -> id, populated by one `list()` call the first time a
   * non-UUID path is requested. */
  private nameToId: Promise<Map<string, string>> | null = null;

  constructor(options: BitwardenProviderOptions = {}) {
    super();
    this.explicitClient = options.client;
    this.accessToken = options.accessToken ?? process.env.BWS_ACCESS_TOKEN;
    this.organizationId = options.organizationId ?? process.env.BWS_ORGANIZATION_ID;
    this.apiUrl = options.apiUrl ?? process.env.BWS_API_URL;
    this.identityUrl = options.identityUrl ?? process.env.BWS_IDENTITY_URL;
    this.stateFile = options.stateFile;
  }

  private getClient(): BitwardenClientLike {
    if (this.explicitClient) return this.explicitClient;
    if (this.client) return this.client;

    if (!this.accessToken) {
      throw new Error(
        "BWS_ACCESS_TOKEN is not set (required for sec://bitwarden/... references)",
      );
    }

    this.client = new BitwardenClient({
      apiUrl: this.apiUrl,
      identityUrl: this.identityUrl,
    }) as unknown as BitwardenClientLike;
    return this.client;
  }

  private async ensureLoggedIn(): Promise<void> {
    if (!this.loggedIn) {
      this.loggedIn = this.getClient()
        .auth()
        .loginAccessToken(this.accessToken as string, this.stateFile)
        .catch((err: unknown) => {
          this.loggedIn = null;
          throw new Error(`could not authenticate with the given access token: ${errorMessage(err)}`);
        });
    }
    return this.loggedIn;
  }

  private async resolveSecretId(path: string): Promise<string> {
    if (UUID_PATTERN.test(path)) return path;

    if (!this.organizationId) {
      throw new Error(
        `"${path}" is not a secret UUID, and no organizationId is configured to look up a ` +
          `secret by name (set BWS_ORGANIZATION_ID, or use the UUID directly)`,
      );
    }

    if (!this.nameToId) {
      this.nameToId = this.ensureLoggedIn().then(async () => {
        const { data } = await this.getClient().secrets().list(this.organizationId as string);
        return new Map(data.map((s) => [s.key, s.id]));
      });
    }

    const map = await this.nameToId;
    const id = map.get(path);
    if (!id) {
      throw new Error(`no secret named "${path}" found in organization "${this.organizationId}"`);
    }
    return id;
  }

  async fetchOne(request: SecretFetchRequest): Promise<string> {
    const id = await this.resolveSecretId(request.path);
    let secret: { value: string };
    try {
      await this.ensureLoggedIn();
      secret = await this.getClient().secrets().get(id);
    } catch (err) {
      throw new Error(`could not fetch secret "${request.path}": ${errorMessage(err)}`);
    }
    return extractField(secret.value, request.field, { provider: this.name, path: request.path });
  }

  async healthCheck(): Promise<ProviderHealth> {
    try {
      await this.ensureLoggedIn();
      return { provider: this.name, ok: true };
    } catch (err) {
      return { provider: this.name, ok: false, message: errorMessage(err) };
    }
  }
}
