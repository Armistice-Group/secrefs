import { verifyClerkSessionToken, type ClerkAuthConfig } from "./clerk.js";

export interface AdminPrincipal {
  clerkUserId: string;
}

/**
 * Resolves a bearer token to a Clerk-authenticated human admin.
 * Deliberately doesn't know or care which org(s) they administer - route
 * handlers separately check `ControlPlaneRepo.isOrgAdmin(clerkUserId, orgId)`
 * against the specific org a request targets, the same two-step shape
 * `auth/principal.ts`'s service-identity resolution already uses
 * (resolve a principal first, authorize it against a specific request
 * after).
 *
 * Returns `undefined` - never throws - for a missing header, an
 * unrecognized token, or when no Clerk config is present at all (see
 * `apps/control-plane/README.md`'s "Admin auth" section for what that
 * means operationally).
 */
export async function resolveAdminPrincipal(
  authorizationHeader: string | undefined,
  clerkConfig: ClerkAuthConfig | undefined,
): Promise<AdminPrincipal | undefined> {
  if (!clerkConfig) return undefined;
  if (!authorizationHeader?.startsWith("Bearer ")) return undefined;
  const token = authorizationHeader.slice("Bearer ".length).trim();
  if (!token) return undefined;

  try {
    const clerkUserId = await verifyClerkSessionToken(token, clerkConfig);
    return { clerkUserId };
  } catch {
    return undefined;
  }
}
