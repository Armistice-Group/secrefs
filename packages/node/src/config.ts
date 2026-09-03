import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { AwsSecretsManagerProvider } from "./providers/aws.js";
import { BitwardenProvider } from "./providers/bitwarden.js";
import { LocalProvider } from "./providers/local.js";
import { VaultProvider } from "./providers/vault.js";
import type { ProviderRegistry } from "./resolver.js";

/**
 * Project configuration: `secrefs.config.json`.
 *
 * The reference format has always supported arbitrary aliases -
 * `ProviderRegistry` is a plain `Record<string, ISecretProvider>` - but
 * only library callers could register them. The CLI was stuck with four
 * hardcoded names, so `secrefs run` could reach exactly one AWS account
 * and one Bitwarden vault. This closes that gap.
 *
 * **This file never holds a secret.** Every credential is referenced by
 * the name of the environment variable that carries it, or by an AWS
 * profile name. That is the whole design constraint: a config file that
 * could hold a token would recreate the `.env` problem one level up, in
 * the tool built to solve it. `secrefs.config.json` is meant to be
 * committed, and nothing in this parser will read a literal credential
 * even if someone puts one there.
 */

export const CONFIG_FILENAME = "secrefs.config.json";

export interface AwsAliasConfig {
  type: "aws";
  /** Named profile from ~/.aws/config. Uses the ambient chain if absent. */
  profile?: string;
  region?: string;
  /** Milliseconds a fetched value may be reused. Default 0 (re-fetch). */
  cacheTtlMs?: number;
  /** Milliseconds a stale value may answer a *transient* failure. */
  staleGraceMs?: number;
}

export interface BitwardenAliasConfig {
  type: "bitwarden";
  /** Name of the env var holding the machine account token. Never the
   * token. Defaults to BWS_ACCESS_TOKEN. */
  tokenEnv?: string;
  /** Name of the env var holding the organization id. */
  organizationIdEnv?: string;
  apiUrl?: string;
  identityUrl?: string;
}

export interface VaultAliasConfig {
  type: "vault";
  /** Name of the env var holding the Vault token. Defaults to VAULT_TOKEN. */
  tokenEnv?: string;
  addr?: string;
}

export interface LocalAliasConfig {
  type: "local";
  /** Path to the gitignored JSON file, relative to the config file. */
  file?: string;
}

export type AliasConfig =
  | AwsAliasConfig
  | BitwardenAliasConfig
  | VaultAliasConfig
  | LocalAliasConfig;

export interface SecRefsConfig {
  providers: Record<string, AliasConfig>;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Field names that would mean a literal credential in the file. Rejected
 * loudly rather than ignored: someone who wrote `"token": "..."` believes
 * it is being used, and silently not using it is worse than refusing. */
const FORBIDDEN_KEYS = new Set([
  "token",
  "accessToken",
  "access_token",
  "secret",
  "secretKey",
  "secretAccessKey",
  "password",
  "apiKey",
  "credential",
  "credentials",
]);

function assertNoInlineSecrets(alias: string, config: Record<string, unknown>): void {
  for (const key of Object.keys(config)) {
    if (FORBIDDEN_KEYS.has(key)) {
      throw new ConfigError(
        `${CONFIG_FILENAME}: provider "${alias}" sets "${key}". This file is meant to be ` +
          `committed and must never contain a credential. Reference the environment variable ` +
          `that holds it instead - e.g. "tokenEnv": "BWS_ACCESS_TOKEN".`,
      );
    }
  }
}

/** Reads an env var named by config, failing with a message that names
 * both the alias and the variable - "BWS_TOKEN_ENG is not set" is
 * actionable in a way that "missing credentials" is not. */
function requireEnv(alias: string, varName: string, env: NodeJS.ProcessEnv): string {
  const value = env[varName];
  if (!value) {
    throw new ConfigError(
      `${CONFIG_FILENAME}: provider "${alias}" expects the credential in ${varName}, ` +
        `but that environment variable is not set.`,
    );
  }
  return value;
}

export function parseConfig(raw: string, source = CONFIG_FILENAME): SecRefsConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(`${source} is not valid JSON: ${(err as Error).message}`);
  }

  // Array.isArray as well as the typeof check: an array is an object to
  // typeof, so `[]` would otherwise slip through and fail later with a
  // message about a missing "providers" key, which is not what is wrong.
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ConfigError(`${source} must contain a JSON object.`);
  }

  const providers = (parsed as { providers?: unknown }).providers;
  if (typeof providers !== "object" || providers === null) {
    throw new ConfigError(`${source} must have a "providers" object.`);
  }

  for (const [alias, value] of Object.entries(providers as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) {
      throw new ConfigError(`${source}: provider "${alias}" must be an object.`);
    }
    const type = (value as { type?: unknown }).type;
    if (type !== "aws" && type !== "bitwarden" && type !== "vault" && type !== "local") {
      throw new ConfigError(
        `${source}: provider "${alias}" has type ${JSON.stringify(type)}; ` +
          `expected one of "aws", "bitwarden", "vault", "local".`,
      );
    }
    assertNoInlineSecrets(alias, value as Record<string, unknown>);
  }

  return parsed as SecRefsConfig;
}

/**
 * Builds a provider registry from parsed config. Aliases entirely replace
 * the built-in defaults rather than merging with them: a config that
 * declares `aws-prod` and `aws-staging` almost certainly does *not* want
 * a third, differently-configured `aws` quietly still working, because
 * that is how a reference ends up resolving against the wrong account.
 */
export function buildProviders(
  config: SecRefsConfig,
  options: { configDir?: string; env?: NodeJS.ProcessEnv } = {},
): ProviderRegistry {
  const env = options.env ?? process.env;
  const configDir = options.configDir ?? process.cwd();
  const registry: ProviderRegistry = {};

  for (const [alias, entry] of Object.entries(config.providers)) {
    switch (entry.type) {
      case "aws":
        registry[alias] = new AwsSecretsManagerProvider({
          region: entry.region,
          cacheTtlMs: entry.cacheTtlMs,
          staleGraceMs: entry.staleGraceMs,
          profile: entry.profile,
        });
        break;
      case "bitwarden":
        registry[alias] = new BitwardenProvider({
          accessToken: requireEnv(alias, entry.tokenEnv ?? "BWS_ACCESS_TOKEN", env),
          organizationId: entry.organizationIdEnv
            ? requireEnv(alias, entry.organizationIdEnv, env)
            : env.BWS_ORGANIZATION_ID,
          apiUrl: entry.apiUrl,
          identityUrl: entry.identityUrl,
        });
        break;
      case "vault":
        registry[alias] = new VaultProvider({
          endpoint: entry.addr ?? env.VAULT_ADDR,
          token: requireEnv(alias, entry.tokenEnv ?? "VAULT_TOKEN", env),
        });
        break;
      case "local":
        registry[alias] = new LocalProvider({
          filePath: entry.file ? resolve(configDir, entry.file) : undefined,
        });
        break;
    }
  }

  return registry;
}

/**
 * Loads `secrefs.config.json` from `dir`, or from the nearest ancestor
 * that has one - so `secrefs run` works from a subdirectory of a repo the
 * way git and every other project tool does. Returns undefined when no
 * config exists anywhere up the tree, which is the common case and not an
 * error: the built-in aliases are used instead.
 */
export function loadConfigFrom(
  dir: string = process.cwd(),
): { config: SecRefsConfig; path: string } | undefined {
  let current = resolve(dir);
  for (;;) {
    const candidate = resolve(current, CONFIG_FILENAME);
    let raw: string;
    try {
      raw = readFileSync(candidate, "utf8");
    } catch {
      const parent = dirname(current);
      if (parent === current) return undefined; // reached the filesystem root
      current = parent;
      continue;
    }
    return { config: parseConfig(raw, candidate), path: candidate };
  }
}
