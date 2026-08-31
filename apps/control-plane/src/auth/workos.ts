import { WorkOS } from "@workos-inc/node";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

export interface WorkOsAuthConfig {
  /** WorkOS API key, from $WORKOS_API_KEY. */
  apiKey: string;
  /** WorkOS AuthKit client id, from $WORKOS_CLIENT_ID - identifies which
   * JWKS to verify a session's access token against. */
  clientId: string;
  /** Injected for testing - overrides how a JWKS-fetching key resolver is
   * built for the client's JWKS URL, so tests never make a real network
   * call. Defaults to jose's `createRemoteJWKSet`. Same shape as
   * auth/oidc.ts's `keyResolverFactory`, deliberately - this is the same
   * "verify a JWT against a JWKS" operation as machine OIDC auth, just
   * for a human session instead of a workload identity. */
  keyResolverFactory?: (jwksUrl: string) => JWTVerifyGetKey;
  /** Injected for testing - overrides verification entirely. Given a
   * bearer token, resolves to the WorkOS user id, or rejects. */
  verify?: (token: string) => Promise<string>;
}

export class WorkOsVerificationError extends Error {}

/**
 * Verifies a WorkOS AuthKit session access token (a human admin's login,
 * `apps/control-plane/README.md`'s "Admin auth" section) and returns the
 * WorkOS user id (`sub` claim) it belongs to. This is the *human*
 * counterpart to auth/oidc.ts's machine workload-identity verification -
 * genuinely the same operation (verify a JWT against a JWKS, extract an
 * identity, let the caller decide what it's allowed to do) rather than
 * just a similar shape, since WorkOS exposes its session tokens' JWKS the
 * same way any OIDC issuer does (`WorkOS.userManagement.getJwksUrl`).
 */
export async function verifyWorkOsSessionToken(token: string, config: WorkOsAuthConfig): Promise<string> {
  if (config.verify) return config.verify(token);

  const jwksUrl = new WorkOS(config.apiKey).userManagement.getJwksUrl(config.clientId);
  const getKey = config.keyResolverFactory
    ? config.keyResolverFactory(jwksUrl)
    : createRemoteJWKSet(new URL(jwksUrl));

  try {
    const { payload } = await jwtVerify(token, getKey);
    if (typeof payload.sub !== "string") {
      throw new WorkOsVerificationError("token has no sub claim");
    }
    return payload.sub;
  } catch (err) {
    if (err instanceof WorkOsVerificationError) throw err;
    throw new WorkOsVerificationError(
      `WorkOS token verification failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
