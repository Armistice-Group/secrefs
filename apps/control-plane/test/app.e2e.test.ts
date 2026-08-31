import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { STSClient } from "@aws-sdk/client-sts";
import { SignJWT, generateKeyPair, type JWTVerifyGetKey } from "jose";
import { buildApp } from "../src/app.js";
import { createContext } from "../src/context.js";
import { openDatabase } from "../src/db/client.js";
import { AesGcmCipher } from "../src/crypto/cipher.js";

/**
 * End-to-end: drives the real Fastify app (in-memory SQLite, a mocked STS
 * client) through the full flow described in
 * docs/control-plane-design.md §7 - connect a vault, define a role and a
 * scoped grant, bind a service identity to it, then mint a credential and
 * confirm both the allow and the deny paths land in the audit log.
 */
describe("control plane end-to-end", () => {
  let app: FastifyInstance;
  let stsSend: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    stsSend = vi.fn().mockResolvedValue({
      Credentials: {
        AccessKeyId: "AKIA_MOCK",
        SecretAccessKey: "mock-secret-key",
        SessionToken: "mock-session-token",
        Expiration: new Date("2026-01-01T00:00:00Z"),
      },
    });
    const fakeStsClient = { send: stsSend } as unknown as STSClient;
    const db = await openDatabase();
    const cipher = new AesGcmCipher(randomBytes(32).toString("base64"));
    // Keeps ARN resolution (a DescribeSecret call through the freshly
    // minted credentials) fully offline - no test here cares about exact-
    // ARN caching specifically, that's covered in awsSts.test.ts.
    const describeClientFactory = () => ({ send: vi.fn().mockResolvedValue({}) });
    app = buildApp(createContext(db, cipher, { stsClient: fakeStsClient, describeClientFactory }));
  });

  it("connects a vault, grants scoped access, mints a credential, and denies out-of-scope access", async () => {
    const org = (
      await app.inject({ method: "POST", url: "/v1/organizations", payload: { name: "Acme Corp" } })
    ).json();

    const identity = (
      await app.inject({
        method: "POST",
        url: "/v1/service-identities",
        payload: { orgId: org.id, name: "ci-deploy-bot" },
      })
    ).json();
    expect(identity.bootstrapToken).toMatch(/^sfcp_/);
    const authHeader = { authorization: `Bearer ${identity.bootstrapToken}` };

    const connection = (
      await app.inject({
        method: "POST",
        url: "/v1/connections",
        payload: {
          orgId: org.id,
          alias: "aws-prod",
          provider: "aws",
          credential: { roleArn: "arn:aws:iam::123456789012:role/SecRefsRole", region: "us-east-1" },
        },
      })
    ).json();
    // The connection response never echoes the credential back.
    expect(connection).not.toHaveProperty("credential");
    expect(connection).not.toHaveProperty("encrypted_credential");

    const role = (
      await app.inject({ method: "POST", url: "/v1/roles", payload: { orgId: org.id, name: "ci-deploy" } })
    ).json();

    await app.inject({
      method: "POST",
      url: `/v1/roles/${role.id}/bindings`,
      payload: { serviceIdentityId: identity.id },
    });

    await app.inject({
      method: "POST",
      url: `/v1/roles/${role.id}/grants`,
      payload: { vaultConnectionId: connection.id, pathPattern: "prod/db", maxTtlSeconds: 300 },
    });

    // In scope: mint succeeds.
    const mintResponse = await app.inject({
      method: "POST",
      url: "/v1/credentials/mint",
      headers: authHeader,
      payload: { alias: "aws-prod", path: "prod/db" },
    });
    expect(mintResponse.statusCode).toBe(200);
    const minted = mintResponse.json();
    expect(minted.credentials.accessKeyId).toBe("AKIA_MOCK");
    expect(stsSend).toHaveBeenCalledTimes(1);
    const assumeRoleInput = stsSend.mock.calls[0]![0].input;
    expect(assumeRoleInput.DurationSeconds).toBe(300); // the grant's max_ttl_seconds

    // Out of scope: no grant covers "prod/billing" - denied, STS never called again.
    const deniedResponse = await app.inject({
      method: "POST",
      url: "/v1/credentials/mint",
      headers: authHeader,
      payload: { alias: "aws-prod", path: "prod/billing" },
    });
    expect(deniedResponse.statusCode).toBe(403);
    expect(stsSend).toHaveBeenCalledTimes(1);

    // Unknown alias: denied before any grant lookup.
    const unknownAliasResponse = await app.inject({
      method: "POST",
      url: "/v1/credentials/mint",
      headers: authHeader,
      payload: { alias: "does-not-exist", path: "prod/db" },
    });
    expect(unknownAliasResponse.statusCode).toBe(403);

    // No/garbage token: 401, never reaches authorization logic at all.
    const noAuthResponse = await app.inject({
      method: "POST",
      url: "/v1/credentials/mint",
      payload: { alias: "aws-prod", path: "prod/db" },
    });
    expect(noAuthResponse.statusCode).toBe(401);

    // The audit trail has exactly the three authorization decisions above
    // (the 401 never reaches the point where an event is recorded).
    const audit = (await app.inject({ method: "GET", url: "/v1/audit", headers: authHeader })).json();
    expect(audit.events).toHaveLength(3);
    const decisions = audit.events.map((e: { decision: string; path: string }) => [e.path, e.decision]);
    expect(decisions).toContainEqual(["prod/db", "allow"]);
    expect(decisions).toContainEqual(["prod/billing", "deny"]);
    expect(decisions).toContainEqual(["prod/db", "deny"]); // the unknown-alias attempt
    // Never logs a secret value or the minted credential itself.
    expect(JSON.stringify(audit)).not.toContain("mock-secret-key");
  });

  it("distributes a Bitwarden connection's pre-provisioned token when authorized, and still enforces RBAC", async () => {
    const org = (
      await app.inject({ method: "POST", url: "/v1/organizations", payload: { name: "Acme Corp" } })
    ).json();
    const identity = (
      await app.inject({
        method: "POST",
        url: "/v1/service-identities",
        payload: { orgId: org.id, name: "ci-deploy-bot" },
      })
    ).json();
    const authHeader = { authorization: `Bearer ${identity.bootstrapToken}` };

    const connection = (
      await app.inject({
        method: "POST",
        url: "/v1/connections",
        payload: {
          orgId: org.id,
          alias: "bw-prod",
          provider: "bitwarden",
          credential: { accessToken: "0.machine-account-token", organizationId: "bw-org-1" },
        },
      })
    ).json();
    expect(connection).not.toHaveProperty("credential");

    const role = (
      await app.inject({ method: "POST", url: "/v1/roles", payload: { orgId: org.id, name: "ci-deploy" } })
    ).json();
    await app.inject({
      method: "POST",
      url: `/v1/roles/${role.id}/bindings`,
      payload: { serviceIdentityId: identity.id },
    });
    await app.inject({
      method: "POST",
      url: `/v1/roles/${role.id}/grants`,
      payload: { vaultConnectionId: connection.id, pathPattern: "prod-db", maxTtlSeconds: 300 },
    });

    // In scope: distributes the stored token. No STS/network call at all -
    // this is a lookup, not a mint.
    const mintResponse = await app.inject({
      method: "POST",
      url: "/v1/credentials/mint",
      headers: authHeader,
      payload: { alias: "bw-prod", path: "prod-db" },
    });
    expect(mintResponse.statusCode).toBe(200);
    const minted = mintResponse.json();
    expect(minted.provider).toBe("bitwarden");
    expect(minted.credentials.accessToken).toBe("0.machine-account-token");
    expect(minted.credentials.organizationId).toBe("bw-org-1");
    expect(minted.credentials.note).toMatch(/not.*freshly minted/i);
    expect(stsSend).not.toHaveBeenCalled();

    // Out of scope: same RBAC path as AWS - still denied.
    const deniedResponse = await app.inject({
      method: "POST",
      url: "/v1/credentials/mint",
      headers: authHeader,
      payload: { alias: "bw-prod", path: "prod-billing" },
    });
    expect(deniedResponse.statusCode).toBe(403);
  });

  it("authenticates via a real OIDC workload identity token instead of a bootstrap token", async () => {
    const ISSUER = "https://token.actions.githubusercontent.com";
    const AUDIENCE = "https://control-plane.example.com";
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const oidcConfig = {
      trustedIssuers: [{ issuer: ISSUER, jwksUrl: "https://example.com/jwks" }],
      audience: AUDIENCE,
      keyResolverFactory: () => (async () => publicKey) as unknown as JWTVerifyGetKey,
    };

    const db = await openDatabase();
    const cipher = new AesGcmCipher(randomBytes(32).toString("base64"));
    const oidcStsSend = vi.fn().mockResolvedValue({
      Credentials: {
        AccessKeyId: "AKIA_OIDC",
        SecretAccessKey: "mock-secret-key",
        SessionToken: "mock-session-token",
        Expiration: new Date("2026-01-01T00:00:00Z"),
      },
    });
    const oidcApp = buildApp(
      createContext(db, cipher, {
        stsClient: { send: oidcStsSend } as unknown as STSClient,
        describeClientFactory: () => ({ send: vi.fn().mockResolvedValue({}) }),
        oidcConfig,
      }),
    );

    const org = (
      await oidcApp.inject({ method: "POST", url: "/v1/organizations", payload: { name: "Acme Corp" } })
    ).json();
    // No bootstrap token used at all for this identity in this test - it
    // exists purely to be reached via its OIDC binding below.
    const identity = (
      await oidcApp.inject({
        method: "POST",
        url: "/v1/service-identities",
        payload: { orgId: org.id, name: "gha-deploy" },
      })
    ).json();

    const bindingResponse = await oidcApp.inject({
      method: "POST",
      url: `/v1/service-identities/${identity.id}/oidc-bindings`,
      payload: { issuer: ISSUER, subjectPattern: "repo:acme/api:ref:refs/heads/main" },
    });
    expect(bindingResponse.statusCode).toBe(201);

    const connection = (
      await oidcApp.inject({
        method: "POST",
        url: "/v1/connections",
        payload: {
          orgId: org.id,
          alias: "aws-prod",
          provider: "aws",
          credential: { roleArn: "arn:aws:iam::123456789012:role/SecRefsRole", region: "us-east-1" },
        },
      })
    ).json();
    const role = (
      await oidcApp.inject({ method: "POST", url: "/v1/roles", payload: { orgId: org.id, name: "gha-deploy" } })
    ).json();
    await oidcApp.inject({
      method: "POST",
      url: `/v1/roles/${role.id}/bindings`,
      payload: { serviceIdentityId: identity.id },
    });
    await oidcApp.inject({
      method: "POST",
      url: `/v1/roles/${role.id}/grants`,
      payload: { vaultConnectionId: connection.id, pathPattern: "prod/db", maxTtlSeconds: 300 },
    });

    const matchingToken = await new SignJWT({ sub: "repo:acme/api:ref:refs/heads/main" })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setExpirationTime("5m")
      .sign(privateKey);

    const mintResponse = await oidcApp.inject({
      method: "POST",
      url: "/v1/credentials/mint",
      headers: { authorization: `Bearer ${matchingToken}` },
      payload: { alias: "aws-prod", path: "prod/db" },
    });
    expect(mintResponse.statusCode).toBe(200);
    expect(mintResponse.json().credentials.accessKeyId).toBe("AKIA_OIDC");

    // A token whose sub doesn't match any registered binding (a different
    // branch) is authenticated as *nobody* - 401, not 403 - since it never
    // resolves to a known principal at all.
    const wrongBranchToken = await new SignJWT({ sub: "repo:acme/api:ref:refs/heads/feature-x" })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setExpirationTime("5m")
      .sign(privateKey);
    const wrongBranchResponse = await oidcApp.inject({
      method: "POST",
      url: "/v1/credentials/mint",
      headers: { authorization: `Bearer ${wrongBranchToken}` },
      payload: { alias: "aws-prod", path: "prod/db" },
    });
    expect(wrongBranchResponse.statusCode).toBe(401);
  });

  it("rejects a request with a bootstrap token that belongs to no service identity", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/credentials/mint",
      headers: { authorization: "Bearer sfcp_totally-made-up" },
      payload: { alias: "aws-prod", path: "prod/db" },
    });
    expect(response.statusCode).toBe(401);
  });
});
