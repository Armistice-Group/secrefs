import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import type { AwsMasterCredential } from "../providers/awsSts.js";

interface CreateConnectionBody {
  orgId: string;
  alias: string;
  provider: "aws";
  credential: AwsMasterCredential;
}

export function registerConnectionRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post<{ Body: CreateConnectionBody }>("/v1/connections", async (request, reply) => {
    const { orgId, alias, provider, credential } = request.body ?? {};
    if (!orgId || !alias || provider !== "aws" || !credential?.roleArn || !credential?.region) {
      return reply.code(400).send({
        error: "orgId, alias, provider (\"aws\"), and credential { roleArn, region } are required",
      });
    }

    const encrypted = ctx.cipher.encrypt(JSON.stringify(credential));
    const connection = ctx.repo.createVaultConnection(orgId, provider, alias, encrypted);

    // Never echo the credential back, encrypted or not.
    return reply.code(201).send({ id: connection.id, orgId, alias, provider });
  });
}
