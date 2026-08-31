import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";

/** One issuer the control plane trusts, with its JWKS URL pinned
 * explicitly rather than discovered - see verifyOidcToken's docstring for
 * why. GitHub Actions / GitLab CI presets are documented in the README;
 * "generic/configurable" just means adding another entry here. */
export interface TrustedOidcIssuer {
  issuer: string;
  jwksUrl: string;
}

export interface OidcConfig {
  trustedIssuers: TrustedOidcIssuer[];
  /** Expected `aud` claim - the control plane's own identifier. Required
   * so a token minted for some *other* audience can't be replayed here. */
  audience: string;
  /** Injected for testing - overrides how a JWKS-fetching key resolver is
   * built for a given JWKS URL, so tests never make a real network call.
   * Defaults to jose's `createRemoteJWKSet`. */
  keyResolverFactory?: (jwksUrl: string) => JWTVerifyGetKey;
}

export class OidcVerificationError extends Error {}

/**
 * Verifies an OIDC ID token (a CI job's workload identity, docs
 * §9) against the configured trust list.
 *
 * Reads the `iss` claim *without trusting it* to pick which JWKS to
 * verify against - critically, this never fetches a JWKS URL that wasn't
 * explicitly pre-configured for that exact issuer string. Naively
 * discovering `jwks_uri` from an issuer's own
 * `/.well-known/openid-configuration` (as full OIDC discovery does) would
 * mean a token merely *claiming* some `iss` gets this server to fetch a
 * URL of the token's choosing - an SSRF footgun. Pinning both issuer and
 * JWKS URL together up front closes that off entirely.
 *
 * On success, verifies the JWT signature, expiration, `iss`, and `aud`,
 * and returns the verified claims - the caller (auth/principal.ts) still
 * has to match `sub` against a registered binding before treating this as
 * an authenticated principal.
 */
export async function verifyOidcToken(token: string, config: OidcConfig): Promise<JWTPayload> {
  const unverifiedIssuer = peekIssuerClaim(token);

  const trusted = config.trustedIssuers.find((t) => t.issuer === unverifiedIssuer);
  if (!trusted) {
    throw new OidcVerificationError(
      unverifiedIssuer
        ? `issuer "${unverifiedIssuer}" is not in the trusted issuer list`
        : "token has no iss claim",
    );
  }

  const getKey = config.keyResolverFactory
    ? config.keyResolverFactory(trusted.jwksUrl)
    : createRemoteJWKSet(new URL(trusted.jwksUrl));

  try {
    const { payload } = await jwtVerify(token, getKey, {
      issuer: trusted.issuer,
      audience: config.audience,
    });
    return payload;
  } catch (err) {
    throw new OidcVerificationError(
      `OIDC token verification failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Decodes (without verifying - this is only ever used to pick which
 * trusted issuer's JWKS to verify *against*, never to make a trust
 * decision on its own) the `iss` claim out of a JWT's payload segment. */
function peekIssuerClaim(token: string): string | undefined {
  const parts = token.split(".");
  const payloadB64 = parts[1];
  if (parts.length !== 3 || !payloadB64) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as { iss?: unknown };
    return typeof payload.iss === "string" ? payload.iss : undefined;
  } catch {
    return undefined;
  }
}
