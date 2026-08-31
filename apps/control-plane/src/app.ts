import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import type { AppContext } from "./context.js";
import { registerOrganizationRoutes } from "./routes/organizations.js";
import { registerIdentityRoutes } from "./routes/identities.js";
import { registerConnectionRoutes } from "./routes/connections.js";
import { registerRoleRoutes } from "./routes/roles.js";
import { registerCredentialRoutes } from "./routes/credentials.js";
import { registerAuditRoutes } from "./routes/audit.js";
import { registerConfigRoutes } from "./routes/config.js";

export interface BuildAppOptions {
  /**
   * Origins the admin console is served from, e.g.
   * `["https://admin.secrefs.com"]` or `["http://localhost:3001"]` -
   * needed because the console is a separate origin from this API, so
   * without CORS every browser request it makes is blocked.
   *
   * Deliberately an explicit allowlist with no wildcard default: an
   * origin that isn't listed gets no CORS headers, so a random site a
   * logged-in admin happens to visit can't drive this API from their
   * browser. Omitted entirely (the default) means no CORS headers at
   * all - correct for an API only ever called server-to-server or by
   * the CLI, which is every deployment that isn't running the console.
   */
  corsOrigins?: string[];
}

/** Builds a Fastify instance wired to `ctx`, without starting it - used
 * both by `server.ts` (real listen) and tests (`app.inject(...)`). */
export function buildApp(ctx: AppContext, options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: false });

  if (options.corsOrigins?.length) {
    // `credentials` stays off: the console authenticates with an explicit
    // Authorization header, never an ambient cookie, so there's nothing
    // for a cross-site request to ride along on.
    void app.register(cors, {
      origin: options.corsOrigins,
      methods: ["GET", "POST", "OPTIONS"],
      allowedHeaders: ["authorization", "content-type"],
      credentials: false,
    });
  }

  app.get("/healthz", async () => ({ ok: true }));

  registerConfigRoutes(app, ctx);

  registerOrganizationRoutes(app, ctx);
  registerIdentityRoutes(app, ctx);
  registerConnectionRoutes(app, ctx);
  registerRoleRoutes(app, ctx);
  registerCredentialRoutes(app, ctx);
  registerAuditRoutes(app, ctx);

  return app;
}
