import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import { resolvePrincipal } from "../auth/principal.js";
import { authorize } from "../rbac/authorize.js";
import { mintAwsCredential, type AwsMasterCredential } from "../providers/awsSts.js";

interface MintBody {
  alias: string;
  path: string;
}

/**
 * The one endpoint that matters most (docs/control-plane-design.md §7):
 * authenticate the caller, authorize the request against its grants, mint
 * a scoped credential for the underlying vault, log the decision either
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

    let credential: AwsMasterCredential;
    try {
      credential = JSON.parse(ctx.cipher.decrypt(decision.connection.encrypted_credential)) as AwsMasterCredential;
    } catch (err) {
      request.log.error({ err }, "failed to decrypt stored connection credential");
      return reply.code(500).send({ error: "could not decrypt connection credential" });
    }

    try {
      const minted = await mintAwsCredential({
        credential,
        path,
        durationSeconds: decision.ttlSeconds,
        client: ctx.stsClient,
      });

      ctx.repo.recordAuthorizationEvent({
        orgId: identity.org_id,
        serviceIdentityId: identity.id,
        vaultConnectionId: decision.connection.id,
        alias,
        path,
        decision: "allow",
      });

      return reply.send({
        provider: "aws" as const,
        credentials: minted,
      });
    } catch (err) {
      // A failure minting the credential is not the same as a denial - it
      // was authorized, the underlying vault call just failed - but it
      // still gets an audit trail entry, and the caller still never sees
      // a partial/garbage credential.
      const message = err instanceof Error ? err.message : String(err);
      ctx.repo.recordAuthorizationEvent({
        orgId: identity.org_id,
        serviceIdentityId: identity.id,
        vaultConnectionId: decision.connection.id,
        alias,
        path,
        decision: "deny",
        reason: `mint failed: ${message}`,
      });
      return reply.code(502).send({ error: `could not mint credential: ${message}` });
    }
  });
}
