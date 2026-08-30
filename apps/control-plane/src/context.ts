import type { ControlPlaneDb } from "./db/client.js";
import { ControlPlaneRepo } from "./db/repo.js";
import type { CredentialCipher } from "./crypto/cipher.js";
import type { STSClient } from "@aws-sdk/client-sts";

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
}

export function createContext(db: ControlPlaneDb, cipher: CredentialCipher, stsClient?: STSClient): AppContext {
  return { db, repo: new ControlPlaneRepo(db), cipher, stsClient };
}
