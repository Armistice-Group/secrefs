import { AwsSecretsManagerProvider } from "./providers/aws.js";
import { VaultProvider } from "./providers/vault.js";
import { LocalProvider } from "./providers/local.js";
import { isSecretRef } from "./parser.js";
import {
  expandKeyValueMap,
  expandProcessEnv,
  checkReferences,
  type ExpandOptions,
  type ProviderRegistry,
} from "./resolver.js";

export {
  parseSecretRef,
  tryParseSecretRef,
  isSecretRef,
  SecRefParseError,
  type ParsedSecretRef,
} from "./parser.js";

export { parseEnvFileText, recoverTruncatedSecRefs } from "./envFile.js";

export {
  BaseSecretProvider,
  SecretFetchError,
  extractField,
  type ISecretProvider,
  type SecretFetchRequest,
  type ProviderHealth,
} from "./providers/base.js";

export { AwsSecretsManagerProvider, type AwsProviderOptions } from "./providers/aws.js";
export { VaultProvider, type VaultProviderOptions } from "./providers/vault.js";
export { LocalProvider, type LocalProviderOptions } from "./providers/local.js";

export {
  expandKeyValueMap,
  expandProcessEnv,
  checkReferences,
  SecRefsResolutionError,
  type ExpandOptions,
  type ProviderRegistry,
  type ResolutionFailure,
  type CheckResult,
} from "./resolver.js";

/** Builds the default provider registry: aws, vault, local. */
export function createDefaultProviders(): ProviderRegistry {
  return {
    aws: new AwsSecretsManagerProvider(),
    vault: new VaultProvider(),
    local: new LocalProvider(),
  };
}

export interface SecRefsOptions {
  providers?: ProviderRegistry;
  strict?: boolean;
}

/**
 * The primary library entry point. Instantiate your own (with a custom
 * provider registry) or use the default `secRefs` singleton below.
 */
export class SecRefs {
  readonly providers: ProviderRegistry;
  readonly strict: boolean;

  constructor(options: SecRefsOptions = {}) {
    this.providers = options.providers ?? createDefaultProviders();
    this.strict = options.strict ?? true;
  }

  private get expandOptions(): ExpandOptions {
    return { providers: this.providers, strict: this.strict };
  }

  /**
   * Expands every `sec://` value found in `process.env`, mutating it in
   * place. Returns the list of env var names that were rewritten.
   */
  async init(): Promise<string[]> {
    return expandProcessEnv(this.expandOptions);
  }

  /**
   * Expands `sec://` values in an arbitrary key/value map (e.g. a parsed
   * `.env` file) without touching `process.env`.
   */
  async expandEnv(env: Record<string, string | undefined>): Promise<Record<string, string>> {
    return expandKeyValueMap(env, this.expandOptions);
  }

  /** Expands a single string if it's a `sec://` reference; otherwise returns it unchanged. */
  async expandString(value: string): Promise<string> {
    if (!isSecretRef(value)) return value;
    const resolved = await expandKeyValueMap({ __value__: value }, this.expandOptions);
    return resolved.__value__ as string;
  }

  /**
   * Dry-run validation of every `sec://` reference in `env` (defaults to
   * `process.env`). Never returns plaintext secret values.
   */
  async check(
    env: Record<string, string | undefined> = process.env,
  ): Promise<Awaited<ReturnType<typeof checkReferences>>> {
    return checkReferences(env, this.expandOptions);
  }
}

/** Convenience singleton mirroring `secRefs.init()` / `secRefs.expandEnv()` / `secRefs.expandString()`. */
export const secRefs = new SecRefs();
