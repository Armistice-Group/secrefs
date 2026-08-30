import Fastify, { type FastifyInstance } from "fastify";
import type { AppContext } from "./context.js";
import { registerOrganizationRoutes } from "./routes/organizations.js";
import { registerIdentityRoutes } from "./routes/identities.js";
import { registerConnectionRoutes } from "./routes/connections.js";
import { registerRoleRoutes } from "./routes/roles.js";
import { registerCredentialRoutes } from "./routes/credentials.js";
import { registerAuditRoutes } from "./routes/audit.js";

/** Builds a Fastify instance wired to `ctx`, without starting it - used
 * both by `server.ts` (real listen) and tests (`app.inject(...)`). */
export function buildApp(ctx: AppContext): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get("/healthz", async () => ({ ok: true }));

  registerOrganizationRoutes(app, ctx);
  registerIdentityRoutes(app, ctx);
  registerConnectionRoutes(app, ctx);
  registerRoleRoutes(app, ctx);
  registerCredentialRoutes(app, ctx);
  registerAuditRoutes(app, ctx);

  return app;
}
