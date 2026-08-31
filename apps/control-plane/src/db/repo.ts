import { randomUUID } from "node:crypto";
import type { ControlPlaneDb } from "./client.js";

export type OrgPlan = "free" | "paid";

export interface Organization {
  id: string;
  name: string;
  plan: OrgPlan;
}

export interface OrgAdmin {
  id: string;
  org_id: string;
  clerk_user_id: string;
  email: string | null;
}

/** Free-tier orgs may connect at most this many vaults - enforced in
 * routes/connections.ts. Bump by changing this one constant; no schema
 * change needed since it's not stored per-org (only the `plan` is). */
export const FREE_TIER_CONNECTION_LIMIT = 3;

export interface ServiceIdentity {
  id: string;
  org_id: string;
  name: string;
}

export type VaultProviderKind = "aws" | "bitwarden";

export interface VaultConnection {
  id: string;
  org_id: string;
  provider: VaultProviderKind;
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

export interface OidcBinding {
  id: string;
  service_identity_id: string;
  issuer: string;
  subject_pattern: string;
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
    return { id, name, plan: "free" };
  }

  findOrganizationById(id: string): Organization | undefined {
    return this.db.prepare("SELECT id, name, plan FROM organizations WHERE id = ?").get(id) as
      | Organization
      | undefined;
  }

  /** Registers `clerkUserId` as an admin of `orgId` - idempotent, so
   * calling it again for the same pair is a no-op rather than an error. */
  createOrgAdmin(orgId: string, clerkUserId: string, email?: string): OrgAdmin {
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT OR IGNORE INTO org_admins (id, org_id, clerk_user_id, email) VALUES (?, ?, ?, ?)",
      )
      .run(id, orgId, clerkUserId, email ?? null);
    return (
      (this.db
        .prepare("SELECT id, org_id, clerk_user_id, email FROM org_admins WHERE org_id = ? AND clerk_user_id = ?")
        .get(orgId, clerkUserId) as OrgAdmin | undefined) ?? { id, org_id: orgId, clerk_user_id: clerkUserId, email: email ?? null }
    );
  }

  isOrgAdmin(clerkUserId: string, orgId: string): boolean {
    const row = this.db
      .prepare("SELECT 1 FROM org_admins WHERE clerk_user_id = ? AND org_id = ?")
      .get(clerkUserId, orgId);
    return row !== undefined;
  }

  /** Every org a given Clerk user administers - powers an admin
   * console's org switcher/landing page. */
  listOrganizationsForAdmin(clerkUserId: string): Organization[] {
    return this.db
      .prepare(
        `SELECT o.id, o.name, o.plan FROM organizations o
         JOIN org_admins a ON a.org_id = o.id
         WHERE a.clerk_user_id = ?
         ORDER BY o.name`,
      )
      .all(clerkUserId) as Organization[];
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

  findServiceIdentityById(id: string): ServiceIdentity | undefined {
    return this.db
      .prepare("SELECT id, org_id, name FROM service_identities WHERE id = ?")
      .get(id) as ServiceIdentity | undefined;
  }

  listServiceIdentities(orgId: string): ServiceIdentity[] {
    return this.db
      .prepare("SELECT id, org_id, name FROM service_identities WHERE org_id = ? ORDER BY name")
      .all(orgId) as ServiceIdentity[];
  }

  createOidcBinding(serviceIdentityId: string, issuer: string, subjectPattern: string): OidcBinding {
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO oidc_bindings (id, service_identity_id, issuer, subject_pattern) VALUES (?, ?, ?, ?)",
      )
      .run(id, serviceIdentityId, issuer, subjectPattern);
    return { id, service_identity_id: serviceIdentityId, issuer, subject_pattern: subjectPattern };
  }

  /** Every binding registered for a given issuer, across every org - the
   * candidate set OIDC principal resolution filters by subject-pattern
   * match (see auth/principal.ts). Small in practice (bindings per issuer,
   * not per request), and indexed on `issuer`. */
  findOidcBindingsByIssuer(issuer: string): OidcBinding[] {
    return this.db
      .prepare(
        "SELECT id, service_identity_id, issuer, subject_pattern FROM oidc_bindings WHERE issuer = ?",
      )
      .all(issuer) as OidcBinding[];
  }

  createVaultConnection(
    orgId: string,
    provider: VaultProviderKind,
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

  countVaultConnections(orgId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as n FROM vault_connections WHERE org_id = ?")
      .get(orgId) as { n: number };
    return row.n;
  }

  /** For an admin console listing - deliberately omits `encrypted_credential`
   * (the query never selects it, not just "the route strips it later") so
   * there's no code path where a future change could accidentally leak it
   * into a response. */
  listVaultConnections(orgId: string): Omit<VaultConnection, "encrypted_credential">[] {
    return this.db
      .prepare("SELECT id, org_id, provider, alias FROM vault_connections WHERE org_id = ? ORDER BY alias")
      .all(orgId) as Omit<VaultConnection, "encrypted_credential">[];
  }

  createRole(orgId: string, name: string): Role {
    const id = randomUUID();
    this.db.prepare("INSERT INTO roles (id, org_id, name) VALUES (?, ?, ?)").run(id, orgId, name);
    return { id, org_id: orgId, name };
  }

  findRoleById(id: string): Role | undefined {
    return this.db.prepare("SELECT id, org_id, name FROM roles WHERE id = ?").get(id) as Role | undefined;
  }

  listRoles(orgId: string): Role[] {
    return this.db
      .prepare("SELECT id, org_id, name FROM roles WHERE org_id = ? ORDER BY name")
      .all(orgId) as Role[];
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

  listGrantsForRole(roleId: string): Grant[] {
    return this.db
      .prepare(
        "SELECT id, role_id, vault_connection_id, path_pattern, max_ttl_seconds FROM grants WHERE role_id = ?",
      )
      .all(roleId) as Grant[];
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
