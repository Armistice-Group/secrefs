// SecRefs control plane schema (v1: AWS Secrets Manager only - see
// docs/control-plane-design.md §5). Deliberately no ORM/migration
// framework yet - one hand-written schema applied idempotently on boot,
// matching the scaffold's "prove the model" scope. Revisit once this
// needs real migrations (multiple deployed versions, non-additive changes).
//
// Kept as a plain SQL string (rather than a separate .sql file) so it
// ships as part of the compiled bundle with no extra asset-copy step.
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A machine principal (CI runner, prod service) that can request minted
-- credentials. Auth is a bootstrap token today (see docs §9) - only its
-- SHA-256 hash is ever stored; the plaintext token is returned exactly
-- once, at creation, and is not retrievable afterward.
CREATE TABLE IF NOT EXISTS service_identities (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  bootstrap_token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One connected vault. \`alias\` is the same alias used in \`sec://<alias>/...\`
-- references. \`encrypted_credential\` is an envelope-encrypted JSON blob
-- (see src/crypto/cipher.ts) - for "aws" it decrypts to
-- { roleArn, region, externalId? }; for "bitwarden", to
-- { accessToken, organizationId? } (see src/providers/bitwarden.ts for why
-- that one is distributed as-is rather than minted per request). Never
-- returned by any read API.
CREATE TABLE IF NOT EXISTS vault_connections (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  provider TEXT NOT NULL CHECK (provider IN ('aws', 'bitwarden')),
  alias TEXT NOT NULL,
  encrypted_credential TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (org_id, alias)
);

CREATE TABLE IF NOT EXISTS roles (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  UNIQUE (org_id, name)
);

CREATE TABLE IF NOT EXISTS role_bindings (
  role_id TEXT NOT NULL REFERENCES roles(id),
  service_identity_id TEXT NOT NULL REFERENCES service_identities(id),
  PRIMARY KEY (role_id, service_identity_id)
);

-- A role's access to one connection, scoped to a path pattern (glob-lite:
-- exact match, trailing "/*" prefix match, or bare "*" for everything -
-- see src/rbac/match.ts). \`max_ttl_seconds\` upper-bounds any credential
-- minted under this grant.
CREATE TABLE IF NOT EXISTS grants (
  id TEXT PRIMARY KEY,
  role_id TEXT NOT NULL REFERENCES roles(id),
  vault_connection_id TEXT NOT NULL REFERENCES vault_connections(id),
  path_pattern TEXT NOT NULL,
  max_ttl_seconds INTEGER NOT NULL DEFAULT 900
);

-- Audit log. Every mint request - allowed or denied - gets one row here.
-- Never the secret value; never even the resolved credential.
CREATE TABLE IF NOT EXISTS authorization_events (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  service_identity_id TEXT NOT NULL,
  vault_connection_id TEXT,
  alias TEXT NOT NULL,
  path TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('allow', 'deny')),
  reason TEXT,
  requested_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;
