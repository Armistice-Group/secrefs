import { describe, expect, it } from "vitest";
import { SignJWT, exportJWK, generateKeyPair, type JWTVerifyGetKey } from "jose";
import { OidcVerificationError, verifyOidcToken } from "../src/auth/oidc.js";

const ISSUER = "https://token.actions.githubusercontent.com";
const AUDIENCE = "https://control-plane.example.com";

/** Signs a real JWT with a real, freshly generated keypair, and returns a
 * `keyResolverFactory` that hands back that same public key regardless of
 * JWKS URL - exercises jose's actual verification logic end to end
 * without any real network call. */
async function signedTestToken(claims: Record<string, unknown>): Promise<{
  token: string;
  keyResolverFactory: () => JWTVerifyGetKey;
}> {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const token = await new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);

  const jwk = await exportJWK(publicKey);
  const keyResolverFactory = () => (async () => publicKey) as unknown as JWTVerifyGetKey;
  void jwk; // kept for readability of what exportJWK would give a real JWKS endpoint
  return { token, keyResolverFactory };
}

describe("verifyOidcToken", () => {
  it("verifies a real signed token against the matching trusted issuer and returns its claims", async () => {
    const { token, keyResolverFactory } = await signedTestToken({
      sub: "repo:acme/api:ref:refs/heads/main",
    });

    const claims = await verifyOidcToken(token, {
      trustedIssuers: [{ issuer: ISSUER, jwksUrl: "https://example.com/jwks" }],
      audience: AUDIENCE,
      keyResolverFactory,
    });

    expect(claims.sub).toBe("repo:acme/api:ref:refs/heads/main");
    expect(claims.iss).toBe(ISSUER);
  });

  it("rejects a token from an issuer that isn't in the trusted list", async () => {
    const { token, keyResolverFactory } = await signedTestToken({ sub: "x" });

    await expect(
      verifyOidcToken(token, {
        trustedIssuers: [{ issuer: "https://some-other-issuer.example.com", jwksUrl: "https://x/jwks" }],
        audience: AUDIENCE,
        keyResolverFactory,
      }),
    ).rejects.toThrow(OidcVerificationError);
  });

  it("never calls the key resolver for an untrusted issuer - no fetch is attempted at all", async () => {
    const { token } = await signedTestToken({ sub: "x" });
    let called = false;
    const keyResolverFactory = () => {
      called = true;
      throw new Error("should never be reached");
    };

    await expect(
      verifyOidcToken(token, {
        trustedIssuers: [{ issuer: "https://some-other-issuer.example.com", jwksUrl: "https://x/jwks" }],
        audience: AUDIENCE,
        keyResolverFactory,
      }),
    ).rejects.toThrow();
    expect(called).toBe(false);
  });

  it("rejects a token signed with a different key than the trusted issuer's", async () => {
    const { token } = await signedTestToken({ sub: "x" });
    const { publicKey: wrongKey } = await generateKeyPair("RS256");

    await expect(
      verifyOidcToken(token, {
        trustedIssuers: [{ issuer: ISSUER, jwksUrl: "https://example.com/jwks" }],
        audience: AUDIENCE,
        keyResolverFactory: () => (async () => wrongKey) as unknown as JWTVerifyGetKey,
      }),
    ).rejects.toThrow(OidcVerificationError);
  });

  it("rejects a token with the wrong audience", async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const token = await new SignJWT({ sub: "x" })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(ISSUER)
      .setAudience("https://someone-elses-service.example.com")
      .setExpirationTime("5m")
      .sign(privateKey);

    await expect(
      verifyOidcToken(token, {
        trustedIssuers: [{ issuer: ISSUER, jwksUrl: "https://example.com/jwks" }],
        audience: AUDIENCE,
        keyResolverFactory: () => (async () => publicKey) as unknown as JWTVerifyGetKey,
      }),
    ).rejects.toThrow(OidcVerificationError);
  });

  it("rejects an expired token", async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const token = await new SignJWT({ sub: "x" })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 1800)
      .sign(privateKey);

    await expect(
      verifyOidcToken(token, {
        trustedIssuers: [{ issuer: ISSUER, jwksUrl: "https://example.com/jwks" }],
        audience: AUDIENCE,
        keyResolverFactory: () => (async () => publicKey) as unknown as JWTVerifyGetKey,
      }),
    ).rejects.toThrow(OidcVerificationError);
  });

  it("rejects a non-JWT string cleanly rather than throwing something opaque", async () => {
    await expect(
      verifyOidcToken("not-a-jwt-at-all", {
        trustedIssuers: [{ issuer: ISSUER, jwksUrl: "https://example.com/jwks" }],
        audience: AUDIENCE,
      }),
    ).rejects.toThrow(OidcVerificationError);
  });
});
