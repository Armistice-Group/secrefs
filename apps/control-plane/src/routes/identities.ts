import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import { generateBootstrapToken } from "../auth/principal.js";

export function registerIdentityRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post<{ Body: { orgId: string; name: string } }>(
    "/v1/service-identities",
    async (request, reply) => {
      const { orgId, name } = request.body ?? {};
      if (!orgId || !name) return reply.code(400).send({ error: "orgId and name are required" });

      const { token, tokenHash } = generateBootstrapToken();
      const identity = ctx.repo.createServiceIdentity(orgId, name, tokenHash);

      // The only response that ever contains the plaintext token - it is
      // not retrievable through any other API afterward.
      return reply.code(201).send({ ...identity, bootstrapToken: token });
    },
  );

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
      const identity = ctx.repo.findServiceIdentityById(request.params.id);
      if (!identity) {
        return reply.code(404).send({ error: `no service identity "${request.params.id}"` });
      }
      const binding = ctx.repo.createOidcBinding(identity.id, issuer, subjectPattern);
      return reply.code(201).send(binding);
    },
  );
}
