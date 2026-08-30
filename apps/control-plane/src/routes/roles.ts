import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";

export function registerRoleRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post<{ Body: { orgId: string; name: string } }>("/v1/roles", async (request, reply) => {
    const { orgId, name } = request.body ?? {};
    if (!orgId || !name) return reply.code(400).send({ error: "orgId and name are required" });
    const role = ctx.repo.createRole(orgId, name);
    return reply.code(201).send(role);
  });

  app.post<{ Params: { roleId: string }; Body: { serviceIdentityId: string } }>(
    "/v1/roles/:roleId/bindings",
    async (request, reply) => {
      const { serviceIdentityId } = request.body ?? {};
      if (!serviceIdentityId) return reply.code(400).send({ error: "serviceIdentityId is required" });
      ctx.repo.bindServiceIdentityToRole(request.params.roleId, serviceIdentityId);
      return reply.code(204).send();
    },
  );

  app.post<{
    Params: { roleId: string };
    Body: { vaultConnectionId: string; pathPattern: string; maxTtlSeconds?: number };
  }>("/v1/roles/:roleId/grants", async (request, reply) => {
    const { vaultConnectionId, pathPattern, maxTtlSeconds } = request.body ?? {};
    if (!vaultConnectionId || !pathPattern) {
      return reply.code(400).send({ error: "vaultConnectionId and pathPattern are required" });
    }
    const grant = ctx.repo.createGrant(
      request.params.roleId,
      vaultConnectionId,
      pathPattern,
      maxTtlSeconds ?? 900,
    );
    return reply.code(201).send(grant);
  });
}
