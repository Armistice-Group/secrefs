import { BitwardenClient } from "@bitwarden/sdk-napi";
import {
  BaseSecretProvider,
  errorMessage,
  extractField,
  type ProviderHealth,
  type SecretFetchRequest,
} from "./base.js";
import { ControlPlaneClient, type ControlPlaneCredentialSource } from "../controlPlaneClient.js";

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
  /** Defaults to $BWS_ACCESS_TOKEN. Ignored if `controlPlane` is set. */
  accessToken?: string;
  /** Required only to resolve a `path` given as a secret *name* rather
   * than its UUID (see class docs). Defaults to $BWS_ORGANIZATION_ID.
   * Ignored if `controlPlane` is set - the control plane's distributed
   * credential supplies this instead. */
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
  /**
   * Sources the access token/organizationId from a running control plane
   * (docs/control-plane-design.md §7/§10, and §8 for why Bitwarden's
   * distribution here isn't the same as AWS's per-request minting -
   * see apps/control-plane/src/providers/bitwarden.ts). Every `fetchOne`
   * call still requests a distribution for its specific `path`, so the
   * control plane's RBAC `Grant.path_pattern` is enforced per secret even
   * though the underlying Bitwarden token itself isn't scoped that
   * narrowly - "SDK-side enforcement" as documented on the control-plane
   * side.
   */
  controlPlane?: ControlPlaneCredentialSource;
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
 *    - if `organizationId` is configured (ambient mode) or supplied by the
 *    control plane (control-plane mode) - a human-readable secret *name*
 *    (Bitwarden's "key" field), resolved via one cached `secrets().list()`
 *    call. With neither, only UUID paths work.
 */
export class BitwardenProvider extends BaseSecretProvider {
  readonly name = "bitwarden";

  private readonly explicitClient?: BitwardenClientLike;
  private readonly ambientAccessToken?: string;
  private readonly ambientOrganizationId?: string;
  private readonly apiUrl?: string;
  private readonly identityUrl?: string;
  private readonly stateFile?: string;
  private readonly controlPlane?: ControlPlaneCredentialSource;
  private readonly controlPlaneClient?: ControlPlaneClient;

  private client: BitwardenClientLike | null = null;
  private loggedInAccessToken: string | null = null;
  private loggedIn: Promise<void> | null = null;
  private organizationId: string | undefined;
  /** Secret name -> id, populated by one `list()` call the first time a
   * non-UUID path is requested. Invalidated if `organizationId` ever
   * changes (control-plane mode, defensively - static in practice). */
  private nameToId: Promise<Map<string, string>> | null = null;

  constructor(options: BitwardenProviderOptions = {}) {
    super();
    this.explicitClient = options.client;
    this.apiUrl = options.apiUrl ?? process.env.BWS_API_URL;
    this.identityUrl = options.identityUrl ?? process.env.BWS_IDENTITY_URL;
    this.stateFile = options.stateFile;
    this.controlPlane = options.controlPlane;

    if (this.controlPlane) {
      this.controlPlaneClient =
        this.controlPlane.client ??
        new ControlPlaneClient({ baseUrl: this.controlPlane.baseUrl, token: this.controlPlane.token });
    } else {
      this.ambientAccessToken = options.accessToken ?? process.env.BWS_ACCESS_TOKEN;
      this.ambientOrganizationId = options.organizationId ?? process.env.BWS_ORGANIZATION_ID;
      this.organizationId = this.ambientOrganizationId;
    }
  }

  private getClient(): BitwardenClientLike {
    if (this.explicitClient) return this.explicitClient;
    if (this.client) return this.client;
    this.client = new BitwardenClient({
      apiUrl: this.apiUrl,
      identityUrl: this.identityUrl,
    }) as unknown as BitwardenClientLike;
    return this.client;
  }

  private async loginWith(accessToken: string, organizationId: string | undefined): Promise<void> {
    if (organizationId !== this.organizationId) {
      this.nameToId = null; // stale cache keyed to a now-superseded org
      this.organizationId = organizationId;
    }
    if (this.loggedInAccessToken === accessToken && this.loggedIn) return this.loggedIn;

    this.loggedInAccessToken = accessToken;
    this.loggedIn = this.getClient()
      .auth()
      .loginAccessToken(accessToken, this.stateFile)
      .catch((err: unknown) => {
        this.loggedIn = null;
        this.loggedInAccessToken = null;
        throw new Error(`could not authenticate with the given access token: ${errorMessage(err)}`);
      });
    return this.loggedIn;
  }

  /** Ensures a session exists for `path`. Ambient mode logs in once
   * (memoized) with the ambient token; control-plane mode requests a
   * distribution for this specific `path` every call - see the
   * `controlPlane` option's docs for why that RBAC check has to be
   * per-path even though the token it returns doesn't vary. */
  private async ensureLoggedInFor(path: string): Promise<void> {
    if (!this.controlPlane) {
      if (!this.ambientAccessToken) {
        throw new Error("BWS_ACCESS_TOKEN is not set (required for sec://bitwarden/... references)");
      }
      return this.loginWith(this.ambientAccessToken, this.ambientOrganizationId);
    }

    const minted = await this.controlPlaneClient!.mintCredential(this.controlPlane.alias, path);
    if (minted.provider !== "bitwarden") {
      throw new Error(
        `control plane returned a "${minted.provider}" credential for alias "${this.controlPlane.alias}", ` +
          `expected "bitwarden"`,
      );
    }
    return this.loginWith(minted.credentials.accessToken, minted.credentials.organizationId);
  }

  /** Assumes `ensureLoggedInFor(path)` has already run for this exact
   * `path` - callers always do that first, so `this.organizationId` is
   * already whatever this path's session resolved to. */
  private async resolveSecretId(path: string): Promise<string> {
    if (UUID_PATTERN.test(path)) return path;

    if (!this.organizationId) {
      throw new Error(
        `"${path}" is not a secret UUID, and no organizationId is available to look up a secret by name ` +
          `(set BWS_ORGANIZATION_ID, use the UUID directly, or - in control-plane mode - the distributed ` +
          `credential didn't include one)`,
      );
    }

    if (!this.nameToId) {
      const organizationId = this.organizationId;
      this.nameToId = (async () => {
        const { data } = await this.getClient().secrets().list(organizationId);
        return new Map(data.map((s) => [s.key, s.id]));
      })();
    }

    const map = await this.nameToId;
    const id = map.get(path);
    if (!id) {
      throw new Error(`no secret named "${path}" found in organization "${this.organizationId}"`);
    }
    return id;
  }

  async fetchOne(request: SecretFetchRequest): Promise<string> {
    let id: string;
    let secret: { value: string };
    try {
      // One ensureLoggedInFor per fetchOne - in control-plane mode this is
      // the one mint/RBAC-gate call for this path; resolveSecretId below
      // relies on it having already set this.organizationId.
      await this.ensureLoggedInFor(request.path);
      id = await this.resolveSecretId(request.path);
      secret = await this.getClient().secrets().get(id);
    } catch (err) {
      throw new Error(`could not fetch secret "${request.path}": ${errorMessage(err)}`);
    }
    return extractField(secret.value, request.field, { provider: this.name, path: request.path });
  }

  async healthCheck(): Promise<ProviderHealth> {
    try {
      await this.ensureLoggedInFor("__secrefs_health_check__");
      return { provider: this.name, ok: true };
    } catch (err) {
      return { provider: this.name, ok: false, message: errorMessage(err) };
    }
  }
}
