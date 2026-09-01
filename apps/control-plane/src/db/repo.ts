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
  workos_user_id: string;
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
  /** ISO-8601, or null for an identity that never expires. Nullable so
   * identities created before expiry existed keep working. */
  expires_at?: string | null;
  /** ISO-8601 of the last successful authentication, or null if never
   * used. This is what surfaces the identity everyone forgot about. */
  last_used_at?: string | null;
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

  async createOrganization(name: string): Promise<Organization> {
    const id = randomUUID();
    await this.db.run("INSERT INTO organizations (id, name) VALUES (?, ?)", [id, name]);
    return { id, name, plan: "free" };
  }

  async findOrganizationById(id: string): Promise<Organization | undefined> {
    return await this.db.get("SELECT id, name, plan FROM organizations WHERE id = ?", [id]) as
      | Organization
      | undefined;
  }

  /** Registers `workOsUserId` as an admin of `orgId` - idempotent, so
   * calling it again for the same pair is a no-op rather than an error. */
  async createOrgAdmin(orgId: string, workOsUserId: string, email?: string): Promise<OrgAdmin> {
    const id = randomUUID();
    await this.db.run("INSERT INTO org_admins (id, org_id, workos_user_id, email) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING", [id, orgId, workOsUserId, email ?? null]);
    return (
      (await this.db.get("SELECT id, org_id, workos_user_id, email FROM org_admins WHERE org_id = ? AND workos_user_id = ?", [orgId, workOsUserId]) as OrgAdmin | undefined) ?? { id, org_id: orgId, workos_user_id: workOsUserId, email: email ?? null }
    );
  }

  async isOrgAdmin(workOsUserId: string, orgId: string): Promise<boolean> {
    const row = await this.db.get("SELECT 1 FROM org_admins WHERE workos_user_id = ? AND org_id = ?", [workOsUserId, orgId]);
    return row !== undefined;
  }

  /** Every org a given WorkOS user administers - powers an admin
   * console's org switcher/landing page. */
  async listOrganizationsForAdmin(workOsUserId: string): Promise<Organization[]> {
    return await this.db.all(`SELECT o.id, o.name, o.plan FROM organizations o
         JOIN org_admins a ON a.org_id = o.id
         WHERE a.workos_user_id = ?
         ORDER BY o.name`, [workOsUserId]) as Organization[];
  }

  /** Returns the created row plus the plaintext bootstrap token - the only
   * time it is ever available. Only its hash is persisted. */
  async createServiceIdentity(
    orgId: string,
    name: string,
    tokenHash: string,
    expiresAt?: string | null,
  ): Promise<ServiceIdentity> {
    const id = randomUUID();
    await this.db.run(
      "INSERT INTO service_identities (id, org_id, name, bootstrap_token_hash, expires_at) VALUES (?, ?, ?, ?, ?)",
      [id, orgId, name, tokenHash, expiresAt ?? null],
    );
    return { id, org_id: orgId, name, expires_at: expiresAt ?? null, last_used_at: null };
  }

  async findServiceIdentityByTokenHash(tokenHash: string): Promise<ServiceIdentity | undefined> {
    return await this.db.get(
      "SELECT id, org_id, name, expires_at, last_used_at FROM service_identities WHERE bootstrap_token_hash = ?",
      [tokenHash],
    ) as ServiceIdentity | undefined;
  }

  async findServiceIdentityById(id: string): Promise<ServiceIdentity | undefined> {
    return await this.db.get(
      "SELECT id, org_id, name, expires_at, last_used_at FROM service_identities WHERE id = ?",
      [id],
    ) as ServiceIdentity | undefined;
  }

  async listServiceIdentities(orgId: string): Promise<ServiceIdentity[]> {
    return await this.db.all(
      "SELECT id, org_id, name, expires_at, last_used_at FROM service_identities WHERE org_id = ? ORDER BY name",
      [orgId],
    ) as ServiceIdentity[];
  }

  /** Records a successful authentication. Best-effort and deliberately
   * not awaited on the auth path - a write failure here must never turn
   * a valid credential into a rejected one. */
  async touchServiceIdentityLastUsed(id: string, at: string = new Date().toISOString()): Promise<void> {
    await this.db.run("UPDATE service_identities SET last_used_at = ? WHERE id = ?", [at, id]);
  }

  async createOidcBinding(serviceIdentityId: string, issuer: string, subjectPattern: string): Promise<OidcBinding> {
    const id = randomUUID();
    await this.db.run("INSERT INTO oidc_bindings (id, service_identity_id, issuer, subject_pattern) VALUES (?, ?, ?, ?)", [id, serviceIdentityId, issuer, subjectPattern]);
    return { id, service_identity_id: serviceIdentityId, issuer, subject_pattern: subjectPattern };
  }

  /** Every binding registered for a given issuer, across every org - the
   * candidate set OIDC principal resolution filters by subject-pattern
   * match (see auth/principal.ts). Small in practice (bindings per issuer,
   * not per request), and indexed on `issuer`. */
  async findOidcBindingsByIssuer(issuer: string): Promise<OidcBinding[]> {
    return await this.db.all("SELECT id, service_identity_id, issuer, subject_pattern FROM oidc_bindings WHERE issuer = ?", [issuer]) as OidcBinding[];
  }

  async createVaultConnection(
    orgId: string,
    provider: VaultProviderKind,
    alias: string,
    encryptedCredential: string,
  ): Promise<VaultConnection> {
    const id = randomUUID();
    await this.db.run("INSERT INTO vault_connections (id, org_id, provider, alias, encrypted_credential) VALUES (?, ?, ?, ?, ?)", [id, orgId, provider, alias, encryptedCredential]);
    return { id, org_id: orgId, provider, alias, encrypted_credential: encryptedCredential };
  }

  async findVaultConnectionByAlias(orgId: string, alias: string): Promise<VaultConnection | undefined> {
    return await this.db.get("SELECT id, org_id, provider, alias, encrypted_credential FROM vault_connections WHERE org_id = ? AND alias = ?", [orgId, alias]) as VaultConnection | undefined;
  }

  async countVaultConnections(orgId: string): Promise<number> {
    const row = (await this.db.get("SELECT COUNT(*) as n FROM vault_connections WHERE org_id = ?", [
      orgId,
    ])) as { n: number | string };
    // Postgres COUNT(*) is a bigint, which node-postgres returns as a
    // *string* rather than lose precision past 2^53. SQLite returns a
    // number. Normalize here so callers (the free-tier limit check in
    // routes/connections.ts) get the number the signature promises,
    // instead of a string that happens to survive `>=` by coercion and
    // would break the moment anyone did arithmetic on it.
    return Number(row.n);
  }

  /** For an admin console listing - deliberately omits `encrypted_credential`
   * (the query never selects it, not just "the route strips it later") so
   * there's no code path where a future change could accidentally leak it
   * into a response. */
  async listVaultConnections(orgId: string): Promise<Omit<VaultConnection, "encrypted_credential">[]> {
    return await this.db.all("SELECT id, org_id, provider, alias FROM vault_connections WHERE org_id = ? ORDER BY alias", [orgId]) as Omit<VaultConnection, "encrypted_credential">[];
  }

  async createRole(orgId: string, name: string): Promise<Role> {
    const id = randomUUID();
    await this.db.run("INSERT INTO roles (id, org_id, name) VALUES (?, ?, ?)", [id, orgId, name]);
    return { id, org_id: orgId, name };
  }

  async findRoleById(id: string): Promise<Role | undefined> {
    return await this.db.get("SELECT id, org_id, name FROM roles WHERE id = ?", [id]) as Role | undefined;
  }

  async listRoles(orgId: string): Promise<Role[]> {
    return await this.db.all("SELECT id, org_id, name FROM roles WHERE org_id = ? ORDER BY name", [orgId]) as Role[];
  }

  async bindServiceIdentityToRole(roleId: string, serviceIdentityId: string): Promise<void> {
    await this.db.run("INSERT INTO role_bindings (role_id, service_identity_id) VALUES (?, ?) ON CONFLICT DO NOTHING", [roleId, serviceIdentityId]);
  }

  async createGrant(
    roleId: string,
    vaultConnectionId: string,
    pathPattern: string,
    maxTtlSeconds: number,
  ): Promise<Grant> {
    const id = randomUUID();
    await this.db.run("INSERT INTO grants (id, role_id, vault_connection_id, path_pattern, max_ttl_seconds) VALUES (?, ?, ?, ?, ?)", [id, roleId, vaultConnectionId, pathPattern, maxTtlSeconds]);
    return { id, role_id: roleId, vault_connection_id: vaultConnectionId, path_pattern: pathPattern, max_ttl_seconds: maxTtlSeconds };
  }

  async listGrantsForRole(roleId: string): Promise<Grant[]> {
    return await this.db.all("SELECT id, role_id, vault_connection_id, path_pattern, max_ttl_seconds FROM grants WHERE role_id = ?", [roleId]) as Grant[];
  }

  /** Every grant reachable by a service identity for one vault connection,
   * via any role it's bound to - the candidate set RBAC matching runs over. */
  async grantsForServiceIdentityAndConnection(
    serviceIdentityId: string,
    vaultConnectionId: string,
  ): Promise<Grant[]> {
    return await this.db.all(`SELECT g.id, g.role_id, g.vault_connection_id, g.path_pattern, g.max_ttl_seconds
         FROM grants g
         JOIN role_bindings rb ON rb.role_id = g.role_id
         WHERE rb.service_identity_id = ? AND g.vault_connection_id = ?`, [serviceIdentityId, vaultConnectionId]) as Grant[];
  }

  async recordAuthorizationEvent(event: {
    orgId: string;
    serviceIdentityId: string;
    vaultConnectionId: string | null;
    alias: string;
    path: string;
    decision: "allow" | "deny";
    reason?: string;
  }): Promise<void> {
    await this.db.run(
      `INSERT INTO authorization_events
           (id, org_id, service_identity_id, vault_connection_id, alias, path, decision, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        randomUUID(),
        event.orgId,
        event.serviceIdentityId,
        event.vaultConnectionId,
        event.alias,
        event.path,
        event.decision,
        event.reason ?? null,
      ],
    );
  }

  async listAuthorizationEvents(orgId: string, limit = 100): Promise<unknown[]> {
    return await this.db.all(`SELECT id, service_identity_id, vault_connection_id, alias, path, decision, reason, requested_at
         FROM authorization_events WHERE org_id = ? ORDER BY requested_at DESC LIMIT ?`, [orgId, limit]);
  }
}
