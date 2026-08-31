import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import { resolveAdminPrincipal } from "../auth/adminPrincipal.js";

export function registerOrganizationRoutes(app: FastifyInstance, ctx: AppContext): void {
  // The one bootstrap case: creating a *new* org has no existing
  // membership to check against, so this only requires *some* valid
  // WorkOS admin principal (any authenticated human), not admin-of-a-
  // specific-org - the creator becomes that org's founding admin.
  app.post<{ Body: { name: string } }>("/v1/organizations", async (request, reply) => {
    const { name } = request.body ?? {};
    if (!name) return reply.code(400).send({ error: "name is required" });

    if (ctx.workOsConfig) {
      const admin = await resolveAdminPrincipal(request.headers.authorization, ctx.workOsConfig);
      if (!admin) {
        return reply.code(401).send({ error: "missing or unrecognized admin session token" });
      }
      const org = ctx.repo.createOrganization(name);
      ctx.repo.createOrgAdmin(org.id, admin.workOsUserId);
      return reply.code(201).send(org);
    }

    const org = ctx.repo.createOrganization(name);
    return reply.code(201).send(org);
  });

  app.get("/v1/organizations", async (request, reply) => {
    if (!ctx.workOsConfig) {
      return reply.code(400).send({
        error: "GET /v1/organizations requires admin auth to be configured (WORKOS_API_KEY unset)",
      });
    }
    const admin = await resolveAdminPrincipal(request.headers.authorization, ctx.workOsConfig);
    if (!admin) {
      return reply.code(401).send({ error: "missing or unrecognized admin session token" });
    }
    return reply.send({ organizations: ctx.repo.listOrganizationsForAdmin(admin.workOsUserId) });
  });
}
