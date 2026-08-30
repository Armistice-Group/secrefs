import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";

/** The credential an org gave the control plane for one AWS connection. */
export interface AwsMasterCredential {
  /** The role the control plane's own AWS identity is trusted to assume. */
  roleArn: string;
  region: string;
  /** Optional STS external ID, if the org's trust policy requires one. */
  externalId?: string;
}

export interface MintAwsCredentialParams {
  credential: AwsMasterCredential;
  /** The single secret path this credential should be scoped to. */
  path: string;
  durationSeconds: number;
  /** Injected for testing - defaults to a real STSClient in `credential.region`. */
  client?: STSClient;
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
 * Builds the Secrets Manager resource ARN for a given secret path. AWS
 * appends a random 6-character suffix to the ARN of every secret it
 * creates, which callers don't know in advance - the trailing `*`
 * absorbs that, at the cost of also matching any other secret that
 * happens to share this one's name as a prefix. Good enough for a v1
 * scaffold; a production version should let an org pin the exact ARN
 * (or resolve it once via `DescribeSecret`) instead of wildcarding it.
 */
export function secretResourceArn(region: string, accountId: string, path: string): string {
  return `arn:aws:secretsmanager:${region}:${accountId}:secret:${path}*`;
}

/**
 * Builds the inline session policy that scopes a minted credential to
 * exactly one secret path - this is what makes the credential "narrowly
 * scoped" rather than inheriting the full breadth of whatever the
 * assumed role could otherwise reach.
 */
export function buildScopedSessionPolicy(resourceArn: string): string {
  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Action: "secretsmanager:GetSecretValue",
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
 */
export async function mintAwsCredential(
  params: MintAwsCredentialParams,
): Promise<MintedAwsCredential> {
  const { credential, path, durationSeconds } = params;
  const client = params.client ?? new STSClient({ region: credential.region });
  const accountId = accountIdFromRoleArn(credential.roleArn);
  const resourceArn = secretResourceArn(credential.region, accountId, path);

  const response = await client.send(
    new AssumeRoleCommand({
      RoleArn: credential.roleArn,
      RoleSessionName: sessionNameFor(path),
      DurationSeconds: durationSeconds,
      Policy: buildScopedSessionPolicy(resourceArn),
      ExternalId: credential.externalId,
    }),
  );

  const creds = response.Credentials;
  if (!creds?.AccessKeyId || !creds.SecretAccessKey || !creds.SessionToken || !creds.Expiration) {
    throw new Error(`AssumeRole for "${credential.roleArn}" returned no usable credentials`);
  }

  return {
    accessKeyId: creds.AccessKeyId,
    secretAccessKey: creds.SecretAccessKey,
    sessionToken: creds.SessionToken,
    expiration: creds.Expiration.toISOString(),
  };
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
