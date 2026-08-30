import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import { resolvePrincipal } from "../auth/principal.js";

export function registerAuditRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/v1/audit", async (request, reply) => {
    const identity = resolvePrincipal(ctx.repo, request.headers.authorization);
    if (!identity) {
      return reply.code(401).send({ error: "missing or unrecognized bootstrap token" });
    }
    return reply.send({ events: ctx.repo.listAuthorizationEvents(identity.org_id) });
  });
}
