import type { ControlPlaneRepo } from "../db/repo.js";
import { resolveAdminPrincipal } from "./adminPrincipal.js";
import type { WorkOsAuthConfig } from "./workos.js";

export type OrgAdminCheck =
  | { ok: true }
  | { ok: false; status: 401; error: string }
  | { ok: false; status: 403; error: string };

/**
 * The gate every management endpoint (connections, roles, grants,
 * service identities) runs through: is the caller a WorkOS-authenticated
 * human who administers `orgId`?
 *
 * If no WorkOS config is present at all, this always succeeds - management
 * endpoints are then unauthenticated. That's a deliberate opt-in
 * tradeoff for simple/local self-hosting (see
 * apps/control-plane/README.md's "Admin auth" section), not an
 * oversight - src/server.ts prints a loud warning at boot when this is
 * the case, precisely so it's never silent.
 */
export const SESSION_COOKIE = "secrefs_session";

/**
 * Accepts the session from either transport.
 *
 * A same-origin console sends an HttpOnly cookie that JavaScript cannot
 * read, which is the point of serving it from this origin - an injected
 * script can't exfiltrate what it can't see. A cross-origin console, and
 * anything scripted, still sends `Authorization: Bearer`.
 *
 * The header wins when both are present: an explicit credential is a
 * deliberate act, an ambient cookie rides along on its own, so on the
 * request where they disagree the explicit one is the one the caller
 * meant.
 */
export function sessionTokenFrom(
  authorizationHeader: string | undefined,
  cookies: Record<string, string | undefined> | undefined,
): string | undefined {
  if (authorizationHeader?.startsWith("Bearer ")) {
    const token = authorizationHeader.slice("Bearer ".length).trim();
    if (token) return token;
  }
  return cookies?.[SESSION_COOKIE] || undefined;
}

export async function requireOrgAdmin(
  repo: ControlPlaneRepo,
  workOsConfig: WorkOsAuthConfig | undefined,
  authorizationHeader: string | undefined,
  orgId: string,
  cookies?: Record<string, string | undefined>,
): Promise<OrgAdminCheck> {
  if (!workOsConfig) return { ok: true };

  const token = sessionTokenFrom(authorizationHeader, cookies);
  const admin = await resolveAdminPrincipal(token ? `Bearer ${token}` : undefined, workOsConfig);
  if (!admin) {
    return { ok: false, status: 401, error: "missing or unrecognized admin session token" };
  }
  if (!(await repo.isOrgAdmin(admin.workOsUserId, orgId))) {
    return { ok: false, status: 403, error: "not an admin of this organization" };
  }
  return { ok: true };
}
