import vaultFactory from "node-vault";
import { TtlCache } from "../ttlCache.js";
import {
  BaseSecretProvider,
  errorMessage,
  extractField,
  type ProviderHealth,
  type SecretFetchRequest,
} from "./base.js";

export interface VaultProviderOptions {
  /** Defaults to $VAULT_ADDR. */
  endpoint?: string;
  /** Defaults to $VAULT_TOKEN. */
  token?: string;
  /** Inject a pre-configured client (primarily for testing). */
  client?: ReturnType<typeof vaultFactory>;
  /** How long a fetched secret may be reused, in ms. Defaults to 0 -
   * every expansion re-fetches, so rotation reaches a long-running
   * consumer without a redeploy. See ../ttlCache.ts. */
  cacheTtlMs?: number;
}

/**
 * HashiCorp Vault provider supporting both KV v1 and KV v2 secrets engines.
 * Auth is ambient via `VAULT_ADDR`/`VAULT_TOKEN` - point `path` at whatever
 * the Vault HTTP API itself expects (KV v2 mounts include a literal `data/`
 * segment, e.g. `secret/data/stripe`; KV v1 mounts do not).
 *
 * The client is constructed lazily on first use so that simply having a
 * `VaultProvider` in your provider registry doesn't require Vault to be
 * configured if you never actually reference `sec://vault/...`.
 */
export class VaultProvider extends BaseSecretProvider {
  readonly name = "vault";

  private readonly explicitClient?: ReturnType<typeof vaultFactory>;
  private readonly endpoint?: string;
  private readonly token?: string;
  private client: ReturnType<typeof vaultFactory> | null = null;
  private readonly dataCache: TtlCache<Record<string, unknown>>;

  constructor(options: VaultProviderOptions = {}) {
    super();
    this.explicitClient = options.client;
    this.endpoint = options.endpoint ?? process.env.VAULT_ADDR;
    this.token = options.token ?? process.env.VAULT_TOKEN;
    this.dataCache = new TtlCache<Record<string, unknown>>({ ttlMs: options.cacheTtlMs });
  }

  private getClient(): ReturnType<typeof vaultFactory> {
    if (this.explicitClient) return this.explicitClient;
    if (this.client) return this.client;

    if (!this.endpoint) {
      throw new Error("VAULT_ADDR is not set (required for sec://vault/... references)");
    }
    if (!this.token) {
      throw new Error("VAULT_TOKEN is not set (required for sec://vault/... references)");
    }

    this.client = vaultFactory({ endpoint: this.endpoint, token: this.token });
    return this.client;
  }

  private getData(path: string): Promise<Record<string, unknown>> {
    return this.dataCache.fetch(path, () =>
      this.getClient()
      .read(path)
      .then((response) => {
        const outer = response.data;
        if (outer === undefined || outer === null) {
          throw new Error(`no data returned for path "${path}"`);
        }
        // KV v2 responses nest the secret under data.data alongside
        // data.metadata; KV v1 responses put the secret straight in data.
        if (
          typeof outer === "object" &&
          "data" in (outer as Record<string, unknown>) &&
          "metadata" in (outer as Record<string, unknown>)
        ) {
          return (outer as Record<string, unknown>).data as Record<string, unknown>;
        }
        return outer as Record<string, unknown>;
      })
      .catch((err: unknown) => {
        throw new Error(`could not read Vault path "${path}": ${errorMessage(err)}`);
      }),
    );
  }

  async fetchOne(request: SecretFetchRequest): Promise<string> {
    const data = await this.getData(request.path);

    if (!request.field) {
      const keys = Object.keys(data);
      // A single-key secret with no #field requested resolves to that
      // key's raw value directly (e.g. Vault's common { value: "..." }
      // convention); anything else is returned as a JSON blob.
      if (keys.length === 1) {
        const only = data[keys[0] as string];
        return typeof only === "string" ? only : JSON.stringify(only);
      }
      return JSON.stringify(data);
    }

    return extractField(JSON.stringify(data), request.field, {
      provider: this.name,
      path: request.path,
    });
  }

  async healthCheck(): Promise<ProviderHealth> {
    try {
      await this.getClient().health();
      return { provider: this.name, ok: true };
    } catch (err) {
      return { provider: this.name, ok: false, message: errorMessage(err) };
    }
  }
}
