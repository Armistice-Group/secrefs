import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { createContext } from "../src/context.js";
import { openDatabase } from "../src/db/client.js";
import { AesGcmCipher } from "../src/crypto/cipher.js";
import type { WorkOsAuthConfig } from "../src/auth/workos.js";
import { FREE_TIER_CONNECTION_LIMIT } from "../src/db/repo.js";

/**
 * End-to-end coverage for the admin-auth gate added on top of every
 * management endpoint (docs: apps/control-plane/README.md's "Admin
 * auth" section). Uses a fake WorkOS verifier (`workOsConfig.verify`) that
 * treats any bearer token as its own literal WorkOS user id, so tests can
 * express "log in as workos_admin_1" without a real WorkOS instance.
 */
describe("control plane - admin-gated management endpoints", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    const db = await openDatabase();
    const cipher = new AesGcmCipher(randomBytes(32).toString("base64"));
    const workOsConfig: WorkOsAuthConfig = {
      apiKey: "sk_test_unused",
      clientId: "client_test_unused",
      verify: async (token) => {
        if (token === "invalid") throw new Error("invalid token");
        return token; // the bearer token IS the workos user id, for test simplicity
      },
    };
    app = buildApp(createContext(db, cipher, { workOsConfig }));
  });

  function asAdmin(workOsUserId: string) {
    return { authorization: `Bearer ${workOsUserId}` };
  }

  it("creating an org auto-admins the creator, who can then manage it", async () => {
    const orgResponse = await app.inject({
      method: "POST",
      url: "/v1/organizations",
      headers: asAdmin("workos_founder"),
      payload: { name: "Acme Corp" },
    });
    expect(orgResponse.statusCode).toBe(201);
    const org = orgResponse.json();

    const connectionResponse = await app.inject({
      method: "POST",
      url: "/v1/connections",
      headers: asAdmin("workos_founder"),
      payload: {
        orgId: org.id,
        alias: "aws-prod",
        provider: "aws",
        credential: { roleArn: "arn:aws:iam::123456789012:role/SecRefsRole", region: "us-east-1" },
      },
    });
    expect(connectionResponse.statusCode).toBe(201);
  });

  it("org creation itself requires some valid admin principal", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/organizations",
      payload: { name: "Acme Corp" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("rejects a management request with no Authorization header at all", async () => {
    const org = (
      await app.inject({
        method: "POST",
        url: "/v1/organizations",
        headers: asAdmin("workos_founder"),
        payload: { name: "Acme Corp" },
      })
    ).json();

    const response = await app.inject({
      method: "POST",
      url: "/v1/roles",
      payload: { orgId: org.id, name: "ci-deploy" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("rejects a management request from a verified admin who isn't an admin of this org", async () => {
    const org = (
      await app.inject({
        method: "POST",
        url: "/v1/organizations",
        headers: asAdmin("workos_founder"),
        payload: { name: "Acme Corp" },
      })
    ).json();

    // workos_stranger is a real, verifiable WorkOS user - just not an admin
    // of this particular org.
    const response = await app.inject({
      method: "POST",
      url: "/v1/roles",
      headers: asAdmin("workos_stranger"),
      payload: { orgId: org.id, name: "ci-deploy" },
    });
    expect(response.statusCode).toBe(403);
  });

  it("GET list endpoints are gated the same way and return what was created", async () => {
    const org = (
      await app.inject({
        method: "POST",
        url: "/v1/organizations",
        headers: asAdmin("workos_founder"),
        payload: { name: "Acme Corp" },
      })
    ).json();
    await app.inject({
      method: "POST",
      url: "/v1/connections",
      headers: asAdmin("workos_founder"),
      payload: {
        orgId: org.id,
        alias: "aws-prod",
        provider: "aws",
        credential: { roleArn: "arn:aws:iam::123456789012:role/SecRefsRole", region: "us-east-1" },
      },
    });

    const denied = await app.inject({
      method: "GET",
      url: `/v1/connections?orgId=${org.id}`,
      headers: asAdmin("workos_stranger"),
    });
    expect(denied.statusCode).toBe(403);

    const allowed = await app.inject({
      method: "GET",
      url: `/v1/connections?orgId=${org.id}`,
      headers: asAdmin("workos_founder"),
    });
    expect(allowed.statusCode).toBe(200);
    const body = allowed.json();
    expect(body.connections).toHaveLength(1);
    expect(body.connections[0].alias).toBe("aws-prod");
    // Never leaks the encrypted credential blob into a list response.
    expect(body.connections[0]).not.toHaveProperty("encrypted_credential");
  });

  it("enforces the free-tier connection limit and returns 402 once it's hit", async () => {
    const org = (
      await app.inject({
        method: "POST",
        url: "/v1/organizations",
        headers: asAdmin("workos_founder"),
        payload: { name: "Acme Corp" },
      })
    ).json();

    for (let i = 0; i < FREE_TIER_CONNECTION_LIMIT; i++) {
      const response = await app.inject({
        method: "POST",
        url: "/v1/connections",
        headers: asAdmin("workos_founder"),
        payload: {
          orgId: org.id,
          alias: `aws-prod-${i}`,
          provider: "aws",
          credential: { roleArn: "arn:aws:iam::123456789012:role/SecRefsRole", region: "us-east-1" },
        },
      });
      expect(response.statusCode).toBe(201);
    }

    const overLimit = await app.inject({
      method: "POST",
      url: "/v1/connections",
      headers: asAdmin("workos_founder"),
      payload: {
        orgId: org.id,
        alias: "one-too-many",
        provider: "aws",
        credential: { roleArn: "arn:aws:iam::123456789012:role/SecRefsRole", region: "us-east-1" },
      },
    });
    expect(overLimit.statusCode).toBe(402);
    expect(overLimit.json().error).toMatch(new RegExp(`limited to ${FREE_TIER_CONNECTION_LIMIT}`));
  });

  it("GET /v1/organizations lists only orgs the caller administers", async () => {
    await app.inject({
      method: "POST",
      url: "/v1/organizations",
      headers: asAdmin("workos_founder"),
      payload: { name: "Founder's Org" },
    });
    await app.inject({
      method: "POST",
      url: "/v1/organizations",
      headers: asAdmin("workos_stranger"),
      payload: { name: "Stranger's Org" },
    });

    const response = await app.inject({
      method: "GET",
      url: "/v1/organizations",
      headers: asAdmin("workos_founder"),
    });
    expect(response.statusCode).toBe(200);
    const orgs = response.json().organizations;
    expect(orgs).toHaveLength(1);
    expect(orgs[0].name).toBe("Founder's Org");
  });
});

describe("control plane - management endpoints with no admin auth configured", () => {
  it("stays open (documented tradeoff) - existing behavior for anyone not opting into WorkOS", async () => {
    const db = await openDatabase();
    const cipher = new AesGcmCipher(randomBytes(32).toString("base64"));
    const app = buildApp(createContext(db, cipher, {})); // no workOsConfig at all

    const response = await app.inject({
      method: "POST",
      url: "/v1/organizations",
      payload: { name: "No Auth Configured Org" },
    });
    expect(response.statusCode).toBe(201);
  });
});
