import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import { resolvePrincipal } from "../auth/principal.js";
import { authorize } from "../rbac/authorize.js";
import { mintAwsCredential, type AwsMasterCredential } from "../providers/awsSts.js";
import { distributeBitwardenCredential, type BitwardenMasterCredential } from "../providers/bitwarden.js";
import type { VaultConnection } from "../db/repo.js";

interface MintBody {
  alias: string;
  path: string;
}

/**
 * Dispatches to the right per-provider handling once a request has
 * already been authorized. AWS mints a fresh, narrowly-scoped credential;
 * Bitwarden distributes its one pre-provisioned token as-is (see
 * providers/bitwarden.ts - not the same guarantee, deliberately not
 * pretended to be).
 */
async function resolveCredential(
  ctx: AppContext,
  connection: VaultConnection,
  path: string,
  ttlSeconds: number,
): Promise<{ provider: string; credentials: unknown }> {
  const raw = JSON.parse(ctx.cipher.decrypt(connection.encrypted_credential)) as unknown;

  if (connection.provider === "aws") {
    const credentials = await mintAwsCredential({
      credential: raw as AwsMasterCredential,
      path,
      durationSeconds: ttlSeconds,
      client: ctx.stsClient,
    });
    return { provider: "aws", credentials };
  }

  const credentials = distributeBitwardenCredential(raw as BitwardenMasterCredential);
  return { provider: "bitwarden", credentials };
}

/**
 * The one endpoint that matters most (docs/control-plane-design.md §7):
 * authenticate the caller, authorize the request against its grants,
 * resolve a credential for the underlying vault, log the decision either
 * way. The secret *value* is never fetched here - only a credential the
 * caller can use to fetch it themselves.
 */
export function registerCredentialRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post<{ Body: MintBody }>("/v1/credentials/mint", async (request, reply) => {
    const identity = resolvePrincipal(ctx.repo, request.headers.authorization);
    if (!identity) {
      return reply.code(401).send({ error: "missing or unrecognized bootstrap token" });
    }

    const { alias, path } = request.body ?? {};
    if (!alias || !path) {
      return reply.code(400).send({ error: "alias and path are required" });
    }

    const decision = authorize(ctx.repo, { orgId: identity.org_id, serviceIdentityId: identity.id, alias, path });

    if (!decision.allowed) {
      ctx.repo.recordAuthorizationEvent({
        orgId: identity.org_id,
        serviceIdentityId: identity.id,
        vaultConnectionId: decision.connectionId,
        alias,
        path,
        decision: "deny",
        reason: decision.reason,
      });
      return reply.code(403).send({ error: decision.reason });
    }

    try {
      const resolved = await resolveCredential(ctx, decision.connection, path, decision.ttlSeconds);

      ctx.repo.recordAuthorizationEvent({
        orgId: identity.org_id,
        serviceIdentityId: identity.id,
        vaultConnectionId: decision.connection.id,
        alias,
        path,
        decision: "allow",
      });

      return reply.send(resolved);
    } catch (err) {
      // A failure resolving the credential is not the same as a denial -
      // it was authorized, decrypting/minting just failed - but it still
      // gets an audit trail entry, and the caller still never sees a
      // partial/garbage credential.
      const message = err instanceof Error ? err.message : String(err);
      ctx.repo.recordAuthorizationEvent({
        orgId: identity.org_id,
        serviceIdentityId: identity.id,
        vaultConnectionId: decision.connection.id,
        alias,
        path,
        decision: "deny",
        reason: `credential resolution failed: ${message}`,
      });
      return reply.code(502).send({ error: `could not resolve credential: ${message}` });
    }
  });
}
