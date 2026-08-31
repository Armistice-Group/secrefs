import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import { DescribeSecretCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

/** The credential an org gave the control plane for one AWS connection. */
export interface AwsMasterCredential {
  /** The role the control plane's own AWS identity is trusted to assume. */
  roleArn: string;
  region: string;
  /** Optional STS external ID, if the org's trust policy requires one. */
  externalId?: string;
}

/**
 * Caches the *exact* Secrets Manager ARN resolved for a given
 * `(connectionKey, path)` pair, so repeat requests scope down to it
 * instead of the wildcard pattern every first-ever request has to use
 * (see `secretResourceArn` below). Deliberately just a `Map` the caller
 * owns and passes in - no module-level global state, and a caller that
 * doesn't care about this optimization can omit it entirely and always
 * get the wildcard-scoped (still-narrow-per-secret-name, just not
 * exact-ARN) behavior.
 */
export type ArnCache = Map<string, string>;

export interface MintAwsCredentialParams {
  credential: AwsMasterCredential;
  /** The single secret path this credential should be scoped to. */
  path: string;
  durationSeconds: number;
  /** A stable key identifying this connection (e.g. the VaultConnection
   * id) - namespaces `arnCache` so two different orgs' secrets that
   * happen to share a `path` string never collide in the cache. */
  connectionKey: string;
  arnCache?: ArnCache;
  /** Injected for testing - defaults to a real STSClient in `credential.region`. */
  client?: STSClient;
  /** Injected for testing - defaults to a real SecretsManagerClient built
   * from the freshly-minted credentials, used only to resolve the exact
   * ARN via DescribeSecret on a cache miss. */
  describeClientFactory?: (creds: MintedAwsCredential, region: string) => Pick<SecretsManagerClient, "send">;
}

export interface MintedAwsCredential {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  /** ISO-8601 expiration timestamp. */
  expiration: string;
}

/** Extracts the account ID segment out of an IAM role ARN. */
export function accountIdFromRoleArn(roleArn: string): string {
  // arn:aws:iam::123456789012:role/SecRefsControlPlaneRole
  const parts = roleArn.split(":");
  const accountId = parts[4];
  if (parts[2] !== "iam" || !accountId) {
    throw new Error(`"${roleArn}" does not look like an IAM role ARN`);
  }
  return accountId;
}

/**
 * Builds the *wildcard-suffixed* Secrets Manager resource ARN for a given
 * secret path - used only until the exact ARN is resolved and cached (see
 * `mintAwsCredential`). AWS appends a random 6-character suffix to the
 * ARN of every secret it creates, which callers don't know in advance;
 * the trailing `*` absorbs that, at the cost of also matching any other
 * secret that happens to share this one's name as a prefix.
 */
export function secretResourceArn(region: string, accountId: string, path: string): string {
  return `arn:aws:secretsmanager:${region}:${accountId}:secret:${path}*`;
}

/**
 * Builds the inline session policy for a mint. `actions` is `["GetSecretValue"]`
 * once the exact ARN is known (tightest possible scope); on a cache miss
 * it's `["GetSecretValue", "DescribeSecret"]` against the wildcard
 * pattern, since resolving the exact ARN requires one DescribeSecret call
 * through the same minted session.
 */
export function buildScopedSessionPolicy(resourceArn: string, actions: string[]): string {
  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Action: actions.map((a) => `secretsmanager:${a}`),
        Resource: resourceArn,
      },
    ],
  });
}

/**
 * Mints a short-lived AWS credential scoped to exactly the requested
 * secret path via `sts:AssumeRole` + an inline session policy. This is
 * the credential-broker half of docs/control-plane-design.md §3/§8: the
 * control plane never reads the secret value itself - it hands the
 * caller a credential and the caller calls Secrets Manager directly.
 *
 * Two-phase ARN scoping: a cache hit (a prior call already resolved this
 * exact `path`'s real ARN) scopes the *entire* minted credential to that
 * one ARN. A cache miss scopes to the wildcard pattern (as broad as this
 * ever gets) but also grants `DescribeSecret`, uses the freshly-minted
 * credential to resolve the exact ARN via one `DescribeSecret` call, and
 * caches it - so only the very first request for a given secret is
 * wildcard-scoped; every request after that is scoped to the one real
 * ARN.
 */
export async function mintAwsCredential(
  params: MintAwsCredentialParams,
): Promise<MintedAwsCredential> {
  const { credential, path, durationSeconds, connectionKey, arnCache } = params;
  const client = params.client ?? new STSClient({ region: credential.region });
  const accountId = accountIdFromRoleArn(credential.roleArn);
  const cacheKey = `${connectionKey}:${path}`;
  const cachedArn = arnCache?.get(cacheKey);

  const resourceArn = cachedArn ?? secretResourceArn(credential.region, accountId, path);
  const actions = cachedArn ? ["GetSecretValue"] : ["GetSecretValue", "DescribeSecret"];

  const response = await client.send(
    new AssumeRoleCommand({
      RoleArn: credential.roleArn,
      RoleSessionName: sessionNameFor(path),
      DurationSeconds: durationSeconds,
      Policy: buildScopedSessionPolicy(resourceArn, actions),
      ExternalId: credential.externalId,
    }),
  );

  const creds = response.Credentials;
  if (!creds?.AccessKeyId || !creds.SecretAccessKey || !creds.SessionToken || !creds.Expiration) {
    throw new Error(`AssumeRole for "${credential.roleArn}" returned no usable credentials`);
  }

  const minted: MintedAwsCredential = {
    accessKeyId: creds.AccessKeyId,
    secretAccessKey: creds.SecretAccessKey,
    sessionToken: creds.SessionToken,
    expiration: creds.Expiration.toISOString(),
  };

  if (!cachedArn && arnCache) {
    // Best-effort: if this fails, the mint above still succeeded and the
    // caller still gets a working (wildcard-scoped) credential - just
    // without the tightening for next time. Never let a resolution
    // failure turn a successful mint into an error.
    try {
      const exactArn = await resolveExactArn(minted, credential.region, path, params.describeClientFactory);
      arnCache.set(cacheKey, exactArn);
    } catch {
      // swallowed deliberately - see comment above
    }
  }

  return minted;
}

async function resolveExactArn(
  minted: MintedAwsCredential,
  region: string,
  path: string,
  describeClientFactory?: MintAwsCredentialParams["describeClientFactory"],
): Promise<string> {
  const client =
    describeClientFactory?.(minted, region) ??
    new SecretsManagerClient({
      region,
      credentials: {
        accessKeyId: minted.accessKeyId,
        secretAccessKey: minted.secretAccessKey,
        sessionToken: minted.sessionToken,
      },
    });

  const response = await client.send(new DescribeSecretCommand({ SecretId: path }));
  if (!response.ARN) {
    throw new Error(`DescribeSecret for "${path}" returned no ARN`);
  }
  return response.ARN;
}

/**
 * STS session names are limited to 64 characters and a restricted
 * character set - derive a short, valid, still-traceable-in-CloudTrail
 * name from the requested path rather than passing it through raw.
 */
function sessionNameFor(path: string): string {
  const sanitized = path.replace(/[^a-zA-Z0-9=,.@_-]/g, "-").slice(0, 40);
  return `secrefs-${sanitized}`;
}
