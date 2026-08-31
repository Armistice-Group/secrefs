import type { Migration } from "./types.js";

/**
 * The schema as it shipped in the original v1 scaffold (PR #3) - see
 * docs/control-plane-design.md §5. Every table this migration doesn't
 * mention didn't exist before it; every column change from here forward
 * is a new migration file, never an edit to this one.
 */
export const migration_0001_init: Migration = {
  id: "0001_init",
  up: async (db) => {
    await db.exec(`
      CREATE TABLE organizations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      -- A machine principal (CI runner, prod service) that can request
      -- minted credentials. Auth is a bootstrap token today (see docs §9)
      -- - only its SHA-256 hash is ever stored; the plaintext token is
      -- returned exactly once, at creation, and is not retrievable
      -- afterward.
      CREATE TABLE service_identities (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL REFERENCES organizations(id),
        name TEXT NOT NULL,
        bootstrap_token_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      -- One connected vault. \`alias\` is the same alias used in
      -- \`sec://<alias>/...\` references. \`encrypted_credential\` is an
      -- envelope-encrypted JSON blob (see src/crypto/cipher.ts) - for
      -- "aws" it decrypts to { roleArn, region, externalId? }; for
      -- "bitwarden", to { accessToken, organizationId? }. Never returned
      -- by any read API.
      CREATE TABLE vault_connections (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL REFERENCES organizations(id),
        provider TEXT NOT NULL CHECK (provider IN ('aws', 'bitwarden')),
        alias TEXT NOT NULL,
        encrypted_credential TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (org_id, alias)
      );

      CREATE TABLE roles (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL REFERENCES organizations(id),
        name TEXT NOT NULL,
        UNIQUE (org_id, name)
      );

      CREATE TABLE role_bindings (
        role_id TEXT NOT NULL REFERENCES roles(id),
        service_identity_id TEXT NOT NULL REFERENCES service_identities(id),
        PRIMARY KEY (role_id, service_identity_id)
      );

      -- A role's access to one connection, scoped to a path pattern
      -- (glob-lite: exact match, trailing "/*" prefix match, or bare "*"
      -- for everything - see src/rbac/match.ts). \`max_ttl_seconds\`
      -- upper-bounds any credential minted under this grant.
      CREATE TABLE grants (
        id TEXT PRIMARY KEY,
        role_id TEXT NOT NULL REFERENCES roles(id),
        vault_connection_id TEXT NOT NULL REFERENCES vault_connections(id),
        path_pattern TEXT NOT NULL,
        max_ttl_seconds INTEGER NOT NULL DEFAULT 900
      );

      -- Audit log. Every mint request - allowed or denied - gets one row
      -- here. Never the secret value; never even the resolved credential.
      CREATE TABLE authorization_events (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        service_identity_id TEXT NOT NULL,
        vault_connection_id TEXT,
        alias TEXT NOT NULL,
        path TEXT NOT NULL,
        decision TEXT NOT NULL CHECK (decision IN ('allow', 'deny')),
        reason TEXT,
        requested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
  },
};
