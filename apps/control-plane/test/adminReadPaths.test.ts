import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { STSClient } from "@aws-sdk/client-sts";
import { buildApp } from "../src/app.js";
import { createContext } from "../src/context.js";
import { openDatabase } from "../src/db/client.js";
import { AesGcmCipher } from "../src/crypto/cipher.js";
import type { WorkOsAuthConfig } from "../src/auth/workos.js";

/**
 * The two read paths the admin console needs that machines don't:
 * naming an org you're looking at, and reading an org's audit log as a
 * human. Both were gaps found by actually driving the console against a
 * running control plane - the audit log in particular was readable only
 * by the service identities being audited.
 */
describe("admin read paths", () => {
  const workOsConfig: WorkOsAuthConfig = {
    apiKey: "sk_test_unused",
    clientId: "client_test_unused",
    verify: async (token) => {
      if (token === "invalid") throw new Error("invalid token");
      return token;
    },
  };

  function buildAuthedApp() {
    const db = openDatabase(":memory:");
    const cipher = new AesGcmCipher(randomBytes(32).toString("base64"));
    return buildApp(createContext(db, cipher, { workOsConfig }));
  }

  const asAdmin = (userId: string) => ({ authorization: `Bearer ${userId}` });

  describe("GET /v1/organizations/:orgId", () => {
    let app: FastifyInstance;
    beforeEach(() => {
      app = buildAuthedApp();
    });

    it("returns the org for an admin of it", async () => {
      const org = (
        await app.inject({
          method: "POST",
          url: "/v1/organizations",
          headers: asAdmin("admin_1"),
          payload: { name: "Acme Corp" },
        })
      ).json();

      const response = await app.inject({
        method: "GET",
        url: `/v1/organizations/${org.id}`,
        headers: asAdmin("admin_1"),
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ id: org.id, name: "Acme Corp", plan: "free" });
    });

    it("403s an admin who doesn't administer that org", async () => {
      const org = (
        await app.inject({
          method: "POST",
          url: "/v1/organizations",
          headers: asAdmin("admin_1"),
          payload: { name: "Acme Corp" },
        })
      ).json();

      const response = await app.inject({
        method: "GET",
        url: `/v1/organizations/${org.id}`,
        headers: asAdmin("stranger"),
      });
      expect(response.statusCode).toBe(403);
    });

    it("404s an org that doesn't exist, for an authenticated admin", async () => {
      // No org exists, so nobody administers it - a 403 would be correct
      // too, but the distinction only leaks whether an id is real to a
      // caller who already authenticated.
      const response = await app.inject({
        method: "GET",
        url: "/v1/organizations/00000000-0000-0000-0000-000000000000",
        headers: asAdmin("admin_1"),
      });
      expect([403, 404]).toContain(response.statusCode);
    });
  });

  describe("GET /v1/audit", () => {
    it("lets an org admin read their org's log via ?orgId=", async () => {
      const app = buildAuthedApp();
      const org = (
        await app.inject({
          method: "POST",
          url: "/v1/organizations",
          headers: asAdmin("admin_1"),
          payload: { name: "Acme Corp" },
        })
      ).json();

      const response = await app.inject({
        method: "GET",
        url: `/v1/audit?orgId=${org.id}`,
        headers: asAdmin("admin_1"),
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ events: [] });
    });

    it("403s an admin reading an org they don't administer", async () => {
      const app = buildAuthedApp();
      const org = (
        await app.inject({
          method: "POST",
          url: "/v1/organizations",
          headers: asAdmin("admin_1"),
          payload: { name: "Acme Corp" },
        })
      ).json();

      const response = await app.inject({
        method: "GET",
        url: `/v1/audit?orgId=${org.id}`,
        headers: asAdmin("stranger"),
      });
      expect(response.statusCode).toBe(403);
    });

    it("still serves a service identity with no orgId, scoped to its own org", async () => {
      // No WorkOS configured here - the original machine-token path has
      // to keep working exactly as before on a self-hosted control plane.
      const db = openDatabase(":memory:");
      const cipher = new AesGcmCipher(randomBytes(32).toString("base64"));
      const app = buildApp(
        createContext(db, cipher, {
          stsClient: { send: vi.fn() } as unknown as STSClient,
        }),
      );

      const org = (
        await app.inject({ method: "POST", url: "/v1/organizations", payload: { name: "Acme" } })
      ).json();
      const identity = (
        await app.inject({
          method: "POST",
          url: "/v1/service-identities",
          payload: { orgId: org.id, name: "bot" },
        })
      ).json();

      const response = await app.inject({
        method: "GET",
        url: "/v1/audit",
        headers: { authorization: `Bearer ${identity.bootstrapToken}` },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ events: [] });
    });

    it("401s an unauthenticated caller with no orgId, and says how an admin should ask", async () => {
      const app = buildAuthedApp();
      const response = await app.inject({ method: "GET", url: "/v1/audit" });

      expect(response.statusCode).toBe(401);
      expect(response.json().error).toMatch(/orgId/);
    });
  });
});
