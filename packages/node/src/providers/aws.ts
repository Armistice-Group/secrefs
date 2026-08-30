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

export interface AwsProviderOptions {
  region?: string;
  /** Inject a pre-configured client (primarily for testing). */
  client?: SecretsManagerClient;
}

/**
 * AWS Secrets Manager provider. Uses the AWS SDK v3 default credential
 * provider chain - environment variables, shared config/credentials files,
 * ECS/EC2 instance metadata, or an assumed IAM role - so no credentials
 * ever need to live in SecRefs configuration itself.
 *
 * Raw secret values fetched per-path are cached in memory for the lifetime
 * of the provider instance so that multiple `#field` references against the
 * same secret only cost one API call.
 */
export class AwsSecretsManagerProvider extends BaseSecretProvider {
  readonly name = "aws";

  private readonly client: SecretsManagerClient;
  private readonly rawCache = new Map<string, Promise<string>>();

  constructor(options: AwsProviderOptions = {}) {
    super();
    this.client =
      options.client ?? new SecretsManagerClient({ region: options.region });
  }

  private getRaw(path: string): Promise<string> {
    const cached = this.rawCache.get(path);
    if (cached) return cached;

    const pending = this.client
      .send(new GetSecretValueCommand({ SecretId: path }))
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
      // A cheap, low-privilege call that proves both network reachability
      // and that the ambient credentials are valid enough to call the API.
      await this.client.send(new ListSecretsCommand({ MaxResults: 1 }));
      return { provider: this.name, ok: true };
    } catch (err) {
      return { provider: this.name, ok: false, message: errorMessage(err) };
    }
  }
}
