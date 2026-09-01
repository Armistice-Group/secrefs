/** Mirrors the control plane's wire types (apps/control-plane/src/db/repo.ts).
 * Kept as a hand-written copy rather than importing from the control plane
 * package: the console is deployable against *any* control plane instance,
 * including one running a different version than it was built against, so
 * a compile-time coupling would imply a guarantee that doesn't hold. */

export type OrgPlan = "free" | "paid";
export type VaultProviderKind = "aws" | "bitwarden";
export type Decision = "allow" | "deny";

export interface Organization {
  id: string;
  name: string;
  plan: OrgPlan;
}

export interface VaultConnection {
  id: string;
  org_id: string;
  provider: VaultProviderKind;
  alias: string;
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

export interface ServiceIdentity {
  id: string;
  org_id: string;
  name: string;
  /** ISO-8601, or null for an identity that never expires. */
  expires_at?: string | null;
  /** ISO-8601 of the last successful authentication, or null if never
   * used. The identity nobody has touched in months is the one worth
   * looking at, so this is surfaced in the list rather than hidden. */
  last_used_at?: string | null;
}

/** Only ever returned once, at creation. */
export interface ServiceIdentityWithToken extends ServiceIdentity {
  bootstrapToken: string;
}

export interface OidcBinding {
  id: string;
  service_identity_id: string;
  issuer: string;
  subject_pattern: string;
}

export interface AuthorizationEvent {
  id: string;
  service_identity_id: string;
  vault_connection_id: string | null;
  alias: string;
  path: string;
  decision: Decision;
  reason: string | null;
  requested_at: string;
}

export interface ControlPlaneConfig {
  adminAuthRequired: boolean;
  adminAuthProvider: "workos" | null;
  oidcEnabled: boolean;
}
