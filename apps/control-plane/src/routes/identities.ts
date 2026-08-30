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
}
