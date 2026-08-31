import type { ControlPlaneDb } from "./db/client.js";
import { ControlPlaneRepo } from "./db/repo.js";
import type { CredentialCipher } from "./crypto/cipher.js";
import type { STSClient } from "@aws-sdk/client-sts";
import type { ArnCache, MintAwsCredentialParams } from "./providers/awsSts.js";
import type { OidcConfig } from "./auth/oidc.js";

/** Everything a route handler needs, gathered in one place so tests can
 * inject fakes (an in-memory db, a fixed cipher key, a mocked STS client)
 * without reaching into module internals. */
export interface AppContext {
  db: ControlPlaneDb;
  repo: ControlPlaneRepo;
  cipher: CredentialCipher;
  /** Injected in tests to avoid making real AWS calls; undefined in
   * production, where each mint call constructs a real STSClient. */
  stsClient?: STSClient;
  /** Exact-ARN cache shared across every mint request this process
   * handles - see providers/awsSts.ts. Lives for the process lifetime;
   * losing it on restart just means the next request per secret
   * re-resolves and re-caches, never a correctness issue. */
  arnCache: ArnCache;
  /** Injected in tests so ARN-resolution never makes a real network call;
   * undefined in production, where a real SecretsManagerClient is built
   * from the freshly-minted credentials. */
  describeClientFactory?: MintAwsCredentialParams["describeClientFactory"];
  /** Undefined when no trusted OIDC issuer is configured - workload
   * identity federation (docs §9) is then simply unavailable and every
   * principal must use a bootstrap token. See auth/principal.ts. */
  oidcConfig?: OidcConfig;
}

export interface CreateContextOptions {
  stsClient?: STSClient;
  describeClientFactory?: MintAwsCredentialParams["describeClientFactory"];
  oidcConfig?: OidcConfig;
}

export function createContext(
  db: ControlPlaneDb,
  cipher: CredentialCipher,
  options: CreateContextOptions = {},
): AppContext {
  return {
    db,
    repo: new ControlPlaneRepo(db),
    cipher,
    stsClient: options.stsClient,
    arnCache: new Map(),
    describeClientFactory: options.describeClientFactory,
    oidcConfig: options.oidcConfig,
  };
}
