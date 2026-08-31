import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import type { AwsMasterCredential } from "../providers/awsSts.js";
import type { BitwardenMasterCredential } from "../providers/bitwarden.js";
import { FREE_TIER_CONNECTION_LIMIT, type VaultProviderKind } from "../db/repo.js";
import { requireOrgAdmin } from "../auth/requireOrgAdmin.js";

interface CreateConnectionBody {
  orgId: string;
  alias: string;
  provider: VaultProviderKind;
  credential: AwsMasterCredential | BitwardenMasterCredential;
}

/** True only when `credential` has every field `provider` requires -
 * narrows the union so the stored blob always matches what the mint route
 * (and the SDK on the other end) expects to find for that provider. */
function isValidCredentialFor(
  provider: VaultProviderKind,
  credential: CreateConnectionBody["credential"],
): boolean {
  if (provider === "aws") {
    const c = credential as Partial<AwsMasterCredential>;
    return Boolean(c.roleArn && c.region);
  }
  const c = credential as Partial<BitwardenMasterCredential>;
  return Boolean(c.accessToken);
}

export function registerConnectionRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post<{ Body: CreateConnectionBody }>("/v1/connections", async (request, reply) => {
    const { orgId, alias, provider, credential } = request.body ?? {};
    if (!orgId || !alias || (provider !== "aws" && provider !== "bitwarden")) {
      return reply.code(400).send({ error: 'orgId, alias, and provider ("aws" | "bitwarden") are required' });
    }

    const admin = await requireOrgAdmin(ctx.repo, ctx.workOsConfig, request.headers.authorization, orgId);
    if (!admin.ok) return reply.code(admin.status).send({ error: admin.error });

    if (!credential || !isValidCredentialFor(provider, credential)) {
      return reply.code(400).send({
        error:
          provider === "aws"
            ? "credential { roleArn, region } is required for provider \"aws\""
            : "credential { accessToken } is required for provider \"bitwarden\"",
      });
    }

    const org = ctx.repo.findOrganizationById(orgId);
    if (org?.plan === "free" && ctx.repo.countVaultConnections(orgId) >= FREE_TIER_CONNECTION_LIMIT) {
      return reply.code(402).send({
        error: `the free plan is limited to ${FREE_TIER_CONNECTION_LIMIT} vault connections - upgrade to add more`,
      });
    }

    const encrypted = await ctx.cipher.encrypt(JSON.stringify(credential), { orgId });
    const connection = ctx.repo.createVaultConnection(orgId, provider, alias, encrypted);

    // Never echo the credential back, encrypted or not.
    return reply.code(201).send({ id: connection.id, orgId, alias, provider });
  });

  app.get<{ Querystring: { orgId?: string } }>("/v1/connections", async (request, reply) => {
    const orgId = request.query.orgId;
    if (!orgId) return reply.code(400).send({ error: "orgId query parameter is required" });

    const admin = await requireOrgAdmin(ctx.repo, ctx.workOsConfig, request.headers.authorization, orgId);
    if (!admin.ok) return reply.code(admin.status).send({ error: admin.error });

    return reply.send({ connections: ctx.repo.listVaultConnections(orgId) });
  });
}
