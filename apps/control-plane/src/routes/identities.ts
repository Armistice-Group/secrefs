import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import { generateBootstrapToken } from "../auth/principal.js";
import { requireOrgAdmin } from "../auth/requireOrgAdmin.js";

export function registerIdentityRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post<{ Body: { orgId: string; name: string; expiresInDays?: number } }>(
    "/v1/service-identities",
    async (request, reply) => {
      const { orgId, name, expiresInDays } = request.body ?? {};
      if (!orgId || !name) return reply.code(400).send({ error: "orgId and name are required" });

      // Expiry is expressed as a duration rather than a timestamp so a
      // caller cannot accidentally create an already-expired identity by
      // sending a stale clock, and so the API has no timezone question.
      let expiresAt: string | null = null;
      if (expiresInDays !== undefined) {
        if (typeof expiresInDays !== "number" || !Number.isFinite(expiresInDays) || expiresInDays <= 0) {
          return reply.code(400).send({ error: "expiresInDays must be a positive number" });
        }
        expiresAt = new Date(Date.now() + expiresInDays * 86_400_000).toISOString();
      }

      const admin = await requireOrgAdmin(ctx.repo, ctx.workOsConfig, request.headers.authorization, orgId);
      if (!admin.ok) return reply.code(admin.status).send({ error: admin.error });

      const { token, tokenHash } = generateBootstrapToken();
      const identity = await ctx.repo.createServiceIdentity(orgId, name, tokenHash, expiresAt);

      // The only response that ever contains the plaintext token - it is
      // not retrievable through any other API afterward.
      return reply.code(201).send({ ...identity, bootstrapToken: token });
    },
  );

  app.get<{ Querystring: { orgId?: string } }>("/v1/service-identities", async (request, reply) => {
    const orgId = request.query.orgId;
    if (!orgId) return reply.code(400).send({ error: "orgId query parameter is required" });

    const admin = await requireOrgAdmin(ctx.repo, ctx.workOsConfig, request.headers.authorization, orgId);
    if (!admin.ok) return reply.code(admin.status).send({ error: admin.error });

    return reply.send({ serviceIdentities: await ctx.repo.listServiceIdentities(orgId) });
  });

  // Trusts a CI job's own OIDC identity token instead of a bootstrap
  // token (docs §9) - see auth/oidc.ts and auth/principal.ts for how a
  // request is actually authenticated against these afterward.
  app.post<{ Params: { id: string }; Body: { issuer: string; subjectPattern: string } }>(
    "/v1/service-identities/:id/oidc-bindings",
    async (request, reply) => {
      const { issuer, subjectPattern } = request.body ?? {};
      if (!issuer || !subjectPattern) {
        return reply.code(400).send({ error: "issuer and subjectPattern are required" });
      }
      const identity = await ctx.repo.findServiceIdentityById(request.params.id);
      if (!identity) {
        return reply.code(404).send({ error: `no service identity "${request.params.id}"` });
      }
      const admin = await requireOrgAdmin(ctx.repo, ctx.workOsConfig, request.headers.authorization, identity.org_id);
      if (!admin.ok) return reply.code(admin.status).send({ error: admin.error });

      const binding = await ctx.repo.createOidcBinding(identity.id, issuer, subjectPattern);
      return reply.code(201).send(binding);
    },
  );
}
