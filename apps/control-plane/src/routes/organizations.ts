import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import { resolveAdminPrincipal } from "../auth/adminPrincipal.js";
import { requireOrgAdmin } from "../auth/requireOrgAdmin.js";

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
      const org = await ctx.repo.createOrganization(name);
      await ctx.repo.createOrgAdmin(org.id, admin.workOsUserId);
      return reply.code(201).send(org);
    }

    const org = await ctx.repo.createOrganization(name);
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
    return reply.send({ organizations: await ctx.repo.listOrganizationsForAdmin(admin.workOsUserId) });
  });

  // One org by id. Unlike the list above this works in no-auth mode too,
  // since it identifies the org explicitly rather than deriving it from
  // a signed-in admin - it's what lets the console name the org you're
  // looking at instead of showing a bare UUID.
  app.get<{ Params: { orgId: string } }>("/v1/organizations/:orgId", async (request, reply) => {
    const { orgId } = request.params;
    const admin = await requireOrgAdmin(ctx.repo, ctx.workOsConfig, request.headers.authorization, orgId);
    if (!admin.ok) return reply.code(admin.status).send({ error: admin.error });

    const org = await ctx.repo.findOrganizationById(orgId);
    if (!org) return reply.code(404).send({ error: `no organization "${orgId}"` });
    return reply.send(org);
  });
}
