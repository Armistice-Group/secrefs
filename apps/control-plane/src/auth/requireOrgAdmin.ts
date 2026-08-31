import type { ControlPlaneRepo } from "../db/repo.js";
import { resolveAdminPrincipal } from "./adminPrincipal.js";
import type { ClerkAuthConfig } from "./clerk.js";

export type OrgAdminCheck =
  | { ok: true }
  | { ok: false; status: 401; error: string }
  | { ok: false; status: 403; error: string };

/**
 * The gate every management endpoint (connections, roles, grants,
 * service identities) runs through: is the caller a Clerk-authenticated
 * human who administers `orgId`?
 *
 * If no Clerk config is present at all, this always succeeds - management
 * endpoints are then unauthenticated. That's a deliberate opt-in
 * tradeoff for simple/local self-hosting (see
 * apps/control-plane/README.md's "Admin auth" section), not an
 * oversight - src/server.ts prints a loud warning at boot when this is
 * the case, precisely so it's never silent.
 */
export async function requireOrgAdmin(
  repo: ControlPlaneRepo,
  clerkConfig: ClerkAuthConfig | undefined,
  authorizationHeader: string | undefined,
  orgId: string,
): Promise<OrgAdminCheck> {
  if (!clerkConfig) return { ok: true };

  const admin = await resolveAdminPrincipal(authorizationHeader, clerkConfig);
  if (!admin) {
    return { ok: false, status: 401, error: "missing or unrecognized admin session token" };
  }
  if (!repo.isOrgAdmin(admin.clerkUserId, orgId)) {
    return { ok: false, status: 403, error: "not an admin of this organization" };
  }
  return { ok: true };
}
