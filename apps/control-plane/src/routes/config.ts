import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";

/**
 * Unauthenticated discovery endpoint so the admin console can tell which
 * deployment mode it's talking to *before* deciding whether to show a
 * login screen: a SecRefs-hosted (or any WorkOS-configured) control plane
 * requires an admin session, a bare self-hosted one doesn't have auth at
 * all. Without this the console would have to guess, or every
 * self-hoster would be stuck at a login wall for auth that isn't
 * configured.
 *
 * Deliberately exposes only booleans about *how to authenticate* - never
 * a key, an issuer list, or anything about what's stored. Knowing that a
 * server requires admin auth tells an attacker nothing they couldn't
 * learn by making one unauthenticated request and reading the 401.
 */
export function registerConfigRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/v1/config", async () => ({
    /** True when management endpoints require a WorkOS admin session. */
    adminAuthRequired: Boolean(ctx.workOsConfig),
    adminAuthProvider: ctx.workOsConfig ? ("workos" as const) : null,
    /** True when CI jobs can authenticate via workload-identity OIDC
     * rather than a bootstrap token - the console surfaces this so an
     * admin knows whether OIDC bindings will actually work. */
    oidcEnabled: Boolean(ctx.oidcConfig),
  }));
}
