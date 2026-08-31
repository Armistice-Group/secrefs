import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import { resolvePrincipal } from "../auth/principal.js";
import { requireOrgAdmin } from "../auth/requireOrgAdmin.js";

/**
 * Reading the audit log accepts *either* kind of caller, because both
 * have a legitimate reason to and they identify their org differently:
 *
 * - A **service identity** (bootstrap token / OIDC) gets its own org's
 *   log, scoped implicitly by its token. This is the original behavior.
 * - An **org admin** passes `?orgId=` explicitly, since a human session
 *   isn't tied to one org the way a machine token is.
 *
 * The admin path exists because the log is for humans reviewing access -
 * gating it to service identities alone meant the only principals who
 * could read it were the machines being audited, which is backwards, and
 * left the admin console unable to show it at all.
 */
export function registerAuditRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get<{ Querystring: { orgId?: string } }>("/v1/audit", async (request, reply) => {
    const orgId = request.query.orgId;

    if (orgId) {
      const admin = await requireOrgAdmin(ctx.repo, ctx.workOsConfig, request.headers.authorization, orgId);
      if (!admin.ok) return reply.code(admin.status).send({ error: admin.error });
      return reply.send({ events: ctx.repo.listAuthorizationEvents(orgId) });
    }

    const identity = await resolvePrincipal(ctx.repo, request.headers.authorization, ctx.oidcConfig);
    if (!identity) {
      return reply.code(401).send({
        error:
          "missing or unrecognized bootstrap token - or, if you're an org admin, pass ?orgId= to read that org's log",
      });
    }
    return reply.send({ events: ctx.repo.listAuthorizationEvents(identity.org_id) });
  });
}
