import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";

export function registerOrganizationRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post<{ Body: { name: string } }>("/v1/organizations", async (request, reply) => {
    const { name } = request.body ?? {};
    if (!name) return reply.code(400).send({ error: "name is required" });
    const org = ctx.repo.createOrganization(name);
    return reply.code(201).send(org);
  });
}
