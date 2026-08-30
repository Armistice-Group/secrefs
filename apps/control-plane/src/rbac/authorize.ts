import type { ControlPlaneRepo, VaultConnection } from "../db/repo.js";
import { matchesPathPattern } from "./match.js";

export type AuthorizationDecision =
  | { allowed: true; connection: VaultConnection; ttlSeconds: number }
  | { allowed: false; reason: string; connectionId: string | null };

/**
 * The RBAC core (docs/control-plane-design.md §6): does this service
 * identity have any grant, via any role it's bound to, whose connection
 * matches `alias` and whose `path_pattern` matches `path`? If several
 * grants match, the credential is minted at the *shortest* of their
 * max TTLs - least privilege wins over convenience.
 */
export function authorize(
  repo: ControlPlaneRepo,
  params: { orgId: string; serviceIdentityId: string; alias: string; path: string },
): AuthorizationDecision {
  const connection = repo.findVaultConnectionByAlias(params.orgId, params.alias);
  if (!connection) {
    return { allowed: false, reason: `no vault connection with alias "${params.alias}"`, connectionId: null };
  }

  const grants = repo.grantsForServiceIdentityAndConnection(params.serviceIdentityId, connection.id);
  const matching = grants.filter((g) => matchesPathPattern(g.path_pattern, params.path));

  if (matching.length === 0) {
    return {
      allowed: false,
      reason: `no grant authorizes path "${params.path}" on connection "${params.alias}"`,
      connectionId: connection.id,
    };
  }

  const ttlSeconds = Math.min(...matching.map((g) => g.max_ttl_seconds));
  return { allowed: true, connection, ttlSeconds };
}
