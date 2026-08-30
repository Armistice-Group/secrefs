/**
 * `node-vault` ships no official type declarations. This is a minimal,
 * intentionally loose shim covering only the surface SecRefs uses
 * (`read` and `health`), plus the factory function's call signature.
 */
declare module "node-vault" {
  interface VaultReadResponse {
    data?: unknown;
    [key: string]: unknown;
  }

  interface VaultClient {
    read(path: string): Promise<VaultReadResponse>;
    health(): Promise<unknown>;
    [key: string]: unknown;
  }

  interface VaultOptions {
    endpoint?: string;
    token?: string;
    apiVersion?: string;
    namespace?: string;
    [key: string]: unknown;
  }

  function vault(options?: VaultOptions): VaultClient;

  export = vault;
}
