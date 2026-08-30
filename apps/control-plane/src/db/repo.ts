import { randomUUID } from "node:crypto";
import type { ControlPlaneDb } from "./client.js";

export interface Organization {
  id: string;
  name: string;
}

export interface ServiceIdentity {
  id: string;
  org_id: string;
  name: string;
}

export interface VaultConnection {
  id: string;
  org_id: string;
  provider: "aws";
  alias: string;
  encrypted_credential: string;
}

export interface Role {
  id: string;
  org_id: string;
  name: string;
}

export interface Grant {
  id: string;
  role_id: string;
  vault_connection_id: string;
  path_pattern: string;
  max_ttl_seconds: number;
}

/** Thin repository over the schema in `schema.ts`. Every write returns the
 * row it created; every id is a UUIDv4 generated here (not by SQLite) so
 * callers can reference it before the transaction commits. */
export class ControlPlaneRepo {
  constructor(private readonly db: ControlPlaneDb) {}

  createOrganization(name: string): Organization {
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO organizations (id, name) VALUES (?, ?)")
      .run(id, name);
    return { id, name };
  }

  /** Returns the created row plus the plaintext bootstrap token - the only
   * time it is ever available. Only its hash is persisted. */
  createServiceIdentity(orgId: string, name: string, tokenHash: string): ServiceIdentity {
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO service_identities (id, org_id, name, bootstrap_token_hash) VALUES (?, ?, ?, ?)",
      )
      .run(id, orgId, name, tokenHash);
    return { id, org_id: orgId, name };
  }

  findServiceIdentityByTokenHash(tokenHash: string): ServiceIdentity | undefined {
    return this.db
      .prepare("SELECT id, org_id, name FROM service_identities WHERE bootstrap_token_hash = ?")
      .get(tokenHash) as ServiceIdentity | undefined;
  }

  createVaultConnection(
    orgId: string,
    provider: "aws",
    alias: string,
    encryptedCredential: string,
  ): VaultConnection {
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO vault_connections (id, org_id, provider, alias, encrypted_credential) VALUES (?, ?, ?, ?, ?)",
      )
      .run(id, orgId, provider, alias, encryptedCredential);
    return { id, org_id: orgId, provider, alias, encrypted_credential: encryptedCredential };
  }

  findVaultConnectionByAlias(orgId: string, alias: string): VaultConnection | undefined {
    return this.db
      .prepare(
        "SELECT id, org_id, provider, alias, encrypted_credential FROM vault_connections WHERE org_id = ? AND alias = ?",
      )
      .get(orgId, alias) as VaultConnection | undefined;
  }

  createRole(orgId: string, name: string): Role {
    const id = randomUUID();
    this.db.prepare("INSERT INTO roles (id, org_id, name) VALUES (?, ?, ?)").run(id, orgId, name);
    return { id, org_id: orgId, name };
  }

  bindServiceIdentityToRole(roleId: string, serviceIdentityId: string): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO role_bindings (role_id, service_identity_id) VALUES (?, ?)",
      )
      .run(roleId, serviceIdentityId);
  }

  createGrant(
    roleId: string,
    vaultConnectionId: string,
    pathPattern: string,
    maxTtlSeconds: number,
  ): Grant {
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO grants (id, role_id, vault_connection_id, path_pattern, max_ttl_seconds) VALUES (?, ?, ?, ?, ?)",
      )
      .run(id, roleId, vaultConnectionId, pathPattern, maxTtlSeconds);
    return { id, role_id: roleId, vault_connection_id: vaultConnectionId, path_pattern: pathPattern, max_ttl_seconds: maxTtlSeconds };
  }

  /** Every grant reachable by a service identity for one vault connection,
   * via any role it's bound to - the candidate set RBAC matching runs over. */
  grantsForServiceIdentityAndConnection(
    serviceIdentityId: string,
    vaultConnectionId: string,
  ): Grant[] {
    return this.db
      .prepare(
        `SELECT g.id, g.role_id, g.vault_connection_id, g.path_pattern, g.max_ttl_seconds
         FROM grants g
         JOIN role_bindings rb ON rb.role_id = g.role_id
         WHERE rb.service_identity_id = ? AND g.vault_connection_id = ?`,
      )
      .all(serviceIdentityId, vaultConnectionId) as Grant[];
  }

  recordAuthorizationEvent(event: {
    orgId: string;
    serviceIdentityId: string;
    vaultConnectionId: string | null;
    alias: string;
    path: string;
    decision: "allow" | "deny";
    reason?: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO authorization_events
           (id, org_id, service_identity_id, vault_connection_id, alias, path, decision, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        event.orgId,
        event.serviceIdentityId,
        event.vaultConnectionId,
        event.alias,
        event.path,
        event.decision,
        event.reason ?? null,
      );
  }

  listAuthorizationEvents(orgId: string, limit = 100): unknown[] {
    return this.db
      .prepare(
        `SELECT id, service_identity_id, vault_connection_id, alias, path, decision, reason, requested_at
         FROM authorization_events WHERE org_id = ? ORDER BY requested_at DESC LIMIT ?`,
      )
      .all(orgId, limit);
  }
}
