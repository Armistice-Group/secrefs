import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createContext } from "../src/context.js";
import { openDatabase } from "../src/db/client.js";
import { AesGcmCipher } from "../src/crypto/cipher.js";
import { GITHUB_ACTIONS_OIDC_ISSUER } from "../src/auth/oidcConfig.js";

function buildTestApp(options: Parameters<typeof createContext>[2] = {}, corsOrigins?: string[]) {
  const db = openDatabase(":memory:");
  const cipher = new AesGcmCipher(randomBytes(32).toString("base64"));
  return buildApp(createContext(db, cipher, options), { corsOrigins });
}

describe("GET /v1/config", () => {
  it("reports admin auth as not required when WorkOS isn't configured", async () => {
    const app = buildTestApp({});
    const response = await app.inject({ method: "GET", url: "/v1/config" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      adminAuthRequired: false,
      adminAuthProvider: null,
      oidcEnabled: false,
    });
  });

  it("reports admin auth as required when WorkOS is configured", async () => {
    const app = buildTestApp({
      workOsConfig: { apiKey: "sk_test", clientId: "client_test", verify: async () => "user_1" },
    });
    const body = (await app.inject({ method: "GET", url: "/v1/config" })).json();

    expect(body.adminAuthRequired).toBe(true);
    expect(body.adminAuthProvider).toBe("workos");
  });

  it("reports whether OIDC workload identity is available", async () => {
    const app = buildTestApp({
      oidcConfig: { trustedIssuers: [GITHUB_ACTIONS_OIDC_ISSUER], audience: "https://cp.example.com" },
    });
    expect((await app.inject({ method: "GET", url: "/v1/config" })).json().oidcEnabled).toBe(true);
  });

  it("never leaks credentials or issuer detail - only booleans about how to authenticate", async () => {
    const app = buildTestApp({
      workOsConfig: { apiKey: "sk_live_super_secret", clientId: "client_abc", verify: async () => "u" },
      oidcConfig: { trustedIssuers: [GITHUB_ACTIONS_OIDC_ISSUER], audience: "https://cp.example.com" },
    });
    const raw = (await app.inject({ method: "GET", url: "/v1/config" })).body;

    expect(raw).not.toContain("sk_live_super_secret");
    expect(raw).not.toContain("client_abc");
    expect(raw).not.toContain("githubusercontent");
    expect(Object.keys(JSON.parse(raw)).sort()).toEqual([
      "adminAuthProvider",
      "adminAuthRequired",
      "oidcEnabled",
    ]);
  });

  it("requires no authentication - the console reads it before it can log in", async () => {
    const app = buildTestApp({
      workOsConfig: { apiKey: "sk_test", clientId: "client_test", verify: async () => "user_1" },
    });
    // No Authorization header at all, on a server that otherwise requires
    // admin auth for every management endpoint.
    expect((await app.inject({ method: "GET", url: "/v1/config" })).statusCode).toBe(200);
  });
});

describe("CORS", () => {
  it("sends no CORS headers when no origins are configured", async () => {
    const app = buildTestApp({});
    const response = await app.inject({
      method: "GET",
      url: "/v1/config",
      headers: { origin: "http://localhost:3001" },
    });
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("allows a configured origin", async () => {
    const app = buildTestApp({}, ["http://localhost:3001"]);
    const response = await app.inject({
      method: "GET",
      url: "/v1/config",
      headers: { origin: "http://localhost:3001" },
    });
    expect(response.headers["access-control-allow-origin"]).toBe("http://localhost:3001");
  });

  it("does not allow an origin that isn't on the allowlist", async () => {
    const app = buildTestApp({}, ["http://localhost:3001"]);
    const response = await app.inject({
      method: "GET",
      url: "/v1/config",
      headers: { origin: "https://evil.example.com" },
    });
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("answers a preflight for an allowed origin with the methods and headers the console needs", async () => {
    const app = buildTestApp({}, ["http://localhost:3001"]);
    const response = await app.inject({
      method: "OPTIONS",
      url: "/v1/connections",
      headers: {
        origin: "http://localhost:3001",
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization,content-type",
      },
    });

    expect(response.statusCode).toBeLessThan(300);
    expect(response.headers["access-control-allow-origin"]).toBe("http://localhost:3001");
    expect(String(response.headers["access-control-allow-methods"])).toContain("POST");
    expect(String(response.headers["access-control-allow-headers"]).toLowerCase()).toContain(
      "authorization",
    );
  });
});
