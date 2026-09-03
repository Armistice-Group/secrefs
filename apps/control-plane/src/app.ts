import Fastify, { type FastifyInstance } from "fastify";
import { existsSync } from "node:fs";
import { join } from "node:path";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
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
  /**
   * Directory of the built admin console. When set, the control plane
   * serves it at its own origin - which is the point: a same-origin
   * console can hold its session in an HttpOnly cookie that JavaScript
   * cannot read, instead of a bearer token in localStorage that any
   * injected script can exfiltrate. It also removes CORS from the
   * picture entirely, and matches what a self-hoster already gets.
   *
   * Unset (the default) leaves the control plane an API-only service.
   */
  consoleDir?: string;
}

/** Builds a Fastify instance wired to `ctx`, without starting it - used
 * both by `server.ts` (real listen) and tests (`app.inject(...)`). */
export function buildApp(ctx: AppContext, options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: false });

  // Security headers. Cosmetic on a bare API; not on a service that
  // manages vault credentials and may be serving the console that
  // administers them.
  void app.register(helmet, {
    // frame-ancestors, not X-Frame-Options alone: clickjacking an admin
    // UI that can create grants is a real attack, and the console is
    // never legitimately framed.
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // Next's static export inlines its bootstrap, so 'unsafe-inline'
        // is required for scripts. Deliberately NOT extended to
        // script-src-attr, so inline event handlers stay blocked.
        scriptSrc: ["'self'", "'unsafe-inline'"],
        scriptSrcAttr: ["'none'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    // Org selection lives in a query parameter, so a full Referer would
    // leak org ids to any outbound link.
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
    hsts: { maxAge: 31_536_000, includeSubDomains: true, preload: false },
    crossOriginEmbedderPolicy: false,
  });

  // Needed to read the session cookie a same-origin console sends. No
  // signing secret: the cookie carries a JWT that is verified on its own
  // merits, so a signature here would add a second key to manage and
  // guard nothing extra.
  void app.register(cookie);

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

  // Registered last so it can serve index.html for unmatched paths
  // without ever shadowing a /v1 route.
  if (options.consoleDir) {
    void app.register(fastifyStatic, { root: options.consoleDir, wildcard: false });
    app.setNotFoundHandler((request, reply) => {
      // API 404s must stay JSON - returning the console's HTML to a
      // programmatic caller turns a clear error into a parse failure.
      if (request.url.startsWith("/v1/") || request.url === "/healthz") {
        return reply.code(404).send({ error: "not found" });
      }
      // `next export` writes flat files, so /roles is roles.html.
      // Existence is checked up front because sendFile streams and does
      // not give us a promise to recover from if the file is missing.
      const urlPath = request.url.split("?")[0] ?? "/";
      const candidate = urlPath === "/" ? "index.html" : `${urlPath.replace(/^\//, "")}.html`;
      const onDisk = existsSync(join(options.consoleDir as string, candidate));
      return reply.type("text/html").sendFile(onDisk ? candidate : "404.html");
    });
  }

  return app;
}
