import { verifyToken } from "@clerk/backend";

export interface ClerkAuthConfig {
  /** Clerk secret key, from $CLERK_SECRET_KEY. */
  secretKey: string;
  /** Injected for testing - overrides real Clerk verification entirely.
   * Given a bearer token, resolves to the Clerk user id, or rejects. */
  verify?: (token: string) => Promise<string>;
}

export class ClerkVerificationError extends Error {}

/**
 * Verifies a Clerk session token (a human admin's login, docs
 * `apps/control-plane/README.md`'s "Admin auth" section) and returns the
 * Clerk user id it belongs to. This is the *human* counterpart to
 * auth/oidc.ts's machine workload-identity verification - same shape
 * (verify a token, extract an identity, let the caller decide what
 * that identity is allowed to do), different token source.
 */
export async function verifyClerkSessionToken(token: string, config: ClerkAuthConfig): Promise<string> {
  if (config.verify) return config.verify(token);

  // @clerk/backend's exact return type isn't cleanly exported across the
  // package boundary (JwtPayload lives in an internal @clerk/shared type),
  // so this checks the documented runtime shape directly - { data, errors? } -
  // rather than fighting cross-package type resolution for what's really
  // just "does this have a .sub".
  let result: { data?: { sub?: unknown }; errors?: { message?: string }[] };
  try {
    result = (await verifyToken(token, { secretKey: config.secretKey })) as typeof result;
  } catch (err) {
    throw new ClerkVerificationError(
      `Clerk token verification failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (result.errors || typeof result.data?.sub !== "string") {
    throw new ClerkVerificationError(result.errors?.[0]?.message ?? "Clerk token verification failed");
  }
  return result.data.sub;
}
