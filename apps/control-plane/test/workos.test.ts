import { describe, expect, it } from "vitest";
import { SignJWT, generateKeyPair, type JWTVerifyGetKey } from "jose";
import { verifyWorkOsSessionToken, WorkOsVerificationError } from "../src/auth/workos.js";

/**
 * Exercises the real `jwtVerify` code path in workos.ts - a genuinely
 * signed RS256 JWT, with only the JWKS network fetch swapped out via
 * `keyResolverFactory` (the same injection point auth/oidc.ts's tests
 * use for machine tokens). `getJwksUrl` itself isn't hit here since the
 * factory bypasses it entirely, matching how a real WorkOS client would
 * only ever be constructed to compute that URL, not to fetch it.
 */
describe("verifyWorkOsSessionToken", () => {
  async function signedTestToken(claims: Record<string, unknown> = {}): Promise<{
    token: string;
    keyResolverFactory: () => JWTVerifyGetKey;
  }> {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const token = await new SignJWT({ sid: "session_123", org_id: "org_abc", ...claims })
      .setProtectedHeader({ alg: "RS256" })
      .setSubject("user_01ABC")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
    return { token, keyResolverFactory: () => (async () => publicKey) as unknown as JWTVerifyGetKey };
  }

  it("verifies a real signed session token and returns its sub claim", async () => {
    const { token, keyResolverFactory } = await signedTestToken();

    const userId = await verifyWorkOsSessionToken(token, {
      apiKey: "sk_test_unused",
      clientId: "client_test_unused",
      keyResolverFactory,
    });

    expect(userId).toBe("user_01ABC");
  });

  it("rejects a token signed with a different key", async () => {
    const { token } = await signedTestToken();
    const { publicKey: wrongKey } = await generateKeyPair("RS256");

    await expect(
      verifyWorkOsSessionToken(token, {
        apiKey: "sk_test_unused",
        clientId: "client_test_unused",
        keyResolverFactory: () => (async () => wrongKey) as unknown as JWTVerifyGetKey,
      }),
    ).rejects.toThrow(WorkOsVerificationError);
  });

  it("rejects an expired token", async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const token = await new SignJWT({ sid: "session_123" })
      .setProtectedHeader({ alg: "RS256" })
      .setSubject("user_01ABC")
      .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 1800)
      .sign(privateKey);

    await expect(
      verifyWorkOsSessionToken(token, {
        apiKey: "sk_test_unused",
        clientId: "client_test_unused",
        keyResolverFactory: () => (async () => publicKey) as unknown as JWTVerifyGetKey,
      }),
    ).rejects.toThrow(WorkOsVerificationError);
  });

  it("rejects a token with no sub claim", async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const token = await new SignJWT({ sid: "session_123" }) // no .setSubject()
      .setProtectedHeader({ alg: "RS256" })
      .setExpirationTime("5m")
      .sign(privateKey);

    await expect(
      verifyWorkOsSessionToken(token, {
        apiKey: "sk_test_unused",
        clientId: "client_test_unused",
        keyResolverFactory: () => (async () => publicKey) as unknown as JWTVerifyGetKey,
      }),
    ).rejects.toThrow(/no sub claim/);
  });

  it("rejects a non-JWT string cleanly", async () => {
    await expect(
      verifyWorkOsSessionToken("not-a-jwt", {
        apiKey: "sk_test_unused",
        clientId: "client_test_unused",
        keyResolverFactory: () => (async () => {
          throw new Error("should not be reached for a malformed token");
        }) as unknown as JWTVerifyGetKey,
      }),
    ).rejects.toThrow(WorkOsVerificationError);
  });

  it("the verify override bypasses jwtVerify entirely", async () => {
    const userId = await verifyWorkOsSessionToken("whatever-token", {
      apiKey: "sk_test_unused",
      clientId: "client_test_unused",
      verify: async (token) => `resolved:${token}`,
    });
    expect(userId).toBe("resolved:whatever-token");
  });
});
