import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import { requireOrgAdmin } from "../auth/requireOrgAdmin.js";

export function registerRoleRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post<{ Body: { orgId: string; name: string } }>("/v1/roles", async (request, reply) => {
    const { orgId, name } = request.body ?? {};
    if (!orgId || !name) return reply.code(400).send({ error: "orgId and name are required" });

    const admin = await requireOrgAdmin(ctx.repo, ctx.workOsConfig, request.headers.authorization, orgId);
    if (!admin.ok) return reply.code(admin.status).send({ error: admin.error });

    const role = ctx.repo.createRole(orgId, name);
    return reply.code(201).send(role);
  });

  app.get<{ Querystring: { orgId?: string } }>("/v1/roles", async (request, reply) => {
    const orgId = request.query.orgId;
    if (!orgId) return reply.code(400).send({ error: "orgId query parameter is required" });

    const admin = await requireOrgAdmin(ctx.repo, ctx.workOsConfig, request.headers.authorization, orgId);
    if (!admin.ok) return reply.code(admin.status).send({ error: admin.error });

    return reply.send({ roles: ctx.repo.listRoles(orgId) });
  });

  app.post<{ Params: { roleId: string }; Body: { serviceIdentityId: string } }>(
    "/v1/roles/:roleId/bindings",
    async (request, reply) => {
      const { serviceIdentityId } = request.body ?? {};
      if (!serviceIdentityId) return reply.code(400).send({ error: "serviceIdentityId is required" });

      const role = ctx.repo.findRoleById(request.params.roleId);
      if (!role) return reply.code(404).send({ error: `no role "${request.params.roleId}"` });
      const admin = await requireOrgAdmin(ctx.repo, ctx.workOsConfig, request.headers.authorization, role.org_id);
      if (!admin.ok) return reply.code(admin.status).send({ error: admin.error });

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

    const role = ctx.repo.findRoleById(request.params.roleId);
    if (!role) return reply.code(404).send({ error: `no role "${request.params.roleId}"` });
    const admin = await requireOrgAdmin(ctx.repo, ctx.workOsConfig, request.headers.authorization, role.org_id);
    if (!admin.ok) return reply.code(admin.status).send({ error: admin.error });

    const grant = ctx.repo.createGrant(
      request.params.roleId,
      vaultConnectionId,
      pathPattern,
      maxTtlSeconds ?? 900,
    );
    return reply.code(201).send(grant);
  });

  app.get<{ Params: { roleId: string } }>("/v1/roles/:roleId/grants", async (request, reply) => {
    const role = ctx.repo.findRoleById(request.params.roleId);
    if (!role) return reply.code(404).send({ error: `no role "${request.params.roleId}"` });
    const admin = await requireOrgAdmin(ctx.repo, ctx.workOsConfig, request.headers.authorization, role.org_id);
    if (!admin.ok) return reply.code(admin.status).send({ error: admin.error });

    return reply.send({ grants: ctx.repo.listGrantsForRole(request.params.roleId) });
  });
}
