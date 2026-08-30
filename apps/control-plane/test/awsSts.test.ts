import { describe, expect, it, vi } from "vitest";
import type { STSClient } from "@aws-sdk/client-sts";
import {
  accountIdFromRoleArn,
  buildScopedSessionPolicy,
  mintAwsCredential,
  secretResourceArn,
} from "../src/providers/awsSts.js";

describe("accountIdFromRoleArn", () => {
  it("extracts the account id segment", () => {
    expect(accountIdFromRoleArn("arn:aws:iam::123456789012:role/SecRefsControlPlaneRole")).toBe(
      "123456789012",
    );
  });

  it("rejects a non-IAM-role ARN", () => {
    expect(() => accountIdFromRoleArn("arn:aws:s3:::some-bucket")).toThrow(/does not look like/);
  });
});

describe("secretResourceArn", () => {
  it("builds a wildcard-suffixed Secrets Manager ARN", () => {
    expect(secretResourceArn("us-east-1", "123456789012", "prod/db")).toBe(
      "arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/db*",
    );
  });
});

describe("buildScopedSessionPolicy", () => {
  it("restricts to exactly GetSecretValue on the given resource", () => {
    const policy = JSON.parse(buildScopedSessionPolicy("arn:aws:secretsmanager:us-east-1:1:secret:x*"));
    expect(policy.Statement).toHaveLength(1);
    expect(policy.Statement[0]).toEqual({
      Effect: "Allow",
      Action: "secretsmanager:GetSecretValue",
      Resource: "arn:aws:secretsmanager:us-east-1:1:secret:x*",
    });
  });
});

describe("mintAwsCredential", () => {
  const credential = {
    roleArn: "arn:aws:iam::123456789012:role/SecRefsControlPlaneRole",
    region: "us-east-1",
  };

  it("calls AssumeRole with a policy scoped to the requested path and returns the minted credential", async () => {
    const send = vi.fn().mockResolvedValue({
      Credentials: {
        AccessKeyId: "AKIA_MOCK",
        SecretAccessKey: "mock-secret-key",
        SessionToken: "mock-session-token",
        Expiration: new Date("2026-01-01T00:00:00Z"),
      },
    });
    const fakeClient = { send } as unknown as STSClient;

    const result = await mintAwsCredential({
      credential,
      path: "prod/db",
      durationSeconds: 900,
      client: fakeClient,
    });

    expect(result).toEqual({
      accessKeyId: "AKIA_MOCK",
      secretAccessKey: "mock-secret-key",
      sessionToken: "mock-session-token",
      expiration: "2026-01-01T00:00:00.000Z",
    });

    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls[0]![0];
    expect(command.input.RoleArn).toBe(credential.roleArn);
    expect(command.input.DurationSeconds).toBe(900);
    const policy = JSON.parse(command.input.Policy);
    expect(policy.Statement[0].Resource).toBe(
      "arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/db*",
    );
  });

  it("throws a clean error if STS returns no usable credentials", async () => {
    const fakeClient = { send: vi.fn().mockResolvedValue({}) } as unknown as STSClient;
    await expect(
      mintAwsCredential({ credential, path: "prod/db", durationSeconds: 900, client: fakeClient }),
    ).rejects.toThrow(/no usable credentials/);
  });
});
