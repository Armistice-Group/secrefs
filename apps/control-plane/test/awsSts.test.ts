import { describe, expect, it, vi } from "vitest";
import type { STSClient } from "@aws-sdk/client-sts";
import {
  accountIdFromRoleArn,
  buildScopedSessionPolicy,
  mintAwsCredential,
  secretResourceArn,
  type ArnCache,
  type MintedAwsCredential,
} from "../src/providers/awsSts.js";

describe("accountIdFromRoleArn", () => {
  it("extracts the account id segment", async () => {
    expect(accountIdFromRoleArn("arn:aws:iam::123456789012:role/SecRefsControlPlaneRole")).toBe(
      "123456789012",
    );
  });

  it("rejects a non-IAM-role ARN", async () => {
    expect(() => accountIdFromRoleArn("arn:aws:s3:::some-bucket")).toThrow(/does not look like/);
  });
});

describe("secretResourceArn", () => {
  it("builds a wildcard-suffixed Secrets Manager ARN", async () => {
    expect(secretResourceArn("us-east-1", "123456789012", "prod/db")).toBe(
      "arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/db*",
    );
  });
});

describe("buildScopedSessionPolicy", () => {
  it("scopes to exactly the given actions and resource", async () => {
    const policy = JSON.parse(
      buildScopedSessionPolicy("arn:aws:secretsmanager:us-east-1:1:secret:x*", ["GetSecretValue"]),
    );
    expect(policy.Statement).toHaveLength(1);
    expect(policy.Statement[0]).toEqual({
      Effect: "Allow",
      Action: ["secretsmanager:GetSecretValue"],
      Resource: "arn:aws:secretsmanager:us-east-1:1:secret:x*",
    });
  });

  it("supports multiple actions (the cache-miss case needs DescribeSecret too)", async () => {
    const policy = JSON.parse(
      buildScopedSessionPolicy("arn:...", ["GetSecretValue", "DescribeSecret"]),
    );
    expect(policy.Statement[0].Action).toEqual([
      "secretsmanager:GetSecretValue",
      "secretsmanager:DescribeSecret",
    ]);
  });
});

describe("mintAwsCredential", () => {
  const credential = {
    roleArn: "arn:aws:iam::123456789012:role/SecRefsControlPlaneRole",
    region: "us-east-1",
  };

  function fakeSts(): { client: STSClient; send: ReturnType<typeof vi.fn> } {
    const send = vi.fn().mockResolvedValue({
      Credentials: {
        AccessKeyId: "AKIA_MOCK",
        SecretAccessKey: "mock-secret-key",
        SessionToken: "mock-session-token",
        Expiration: new Date("2026-01-01T00:00:00Z"),
      },
    });
    return { client: { send } as unknown as STSClient, send };
  }

  function fakeDescribeClientFactory(exactArn: string) {
    const send = vi.fn().mockResolvedValue({ ARN: exactArn });
    const factory = (_creds: MintedAwsCredential, _region: string) => ({ send });
    return { factory, send };
  }

  it("calls AssumeRole with a wildcard-scoped policy on a cache miss, and returns the minted credential", async () => {
    const { client, send } = fakeSts();
    const { factory } = fakeDescribeClientFactory(
      "arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/db-Ab12Cd",
    );

    const result = await mintAwsCredential({
      credential,
      path: "prod/db",
      durationSeconds: 900,
      connectionKey: "conn-1",
      client,
      describeClientFactory: factory,
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
    expect(policy.Statement[0].Action).toEqual([
      "secretsmanager:GetSecretValue",
      "secretsmanager:DescribeSecret",
    ]);
  });

  it("resolves and caches the exact ARN on a cache miss, keyed by connectionKey+path", async () => {
    const { client } = fakeSts();
    const exactArn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/db-Ab12Cd";
    const { factory, send: describeSend } = fakeDescribeClientFactory(exactArn);
    const arnCache: ArnCache = new Map();

    await mintAwsCredential({
      credential,
      path: "prod/db",
      durationSeconds: 900,
      connectionKey: "conn-1",
      arnCache,
      client,
      describeClientFactory: factory,
    });

    expect(describeSend).toHaveBeenCalledTimes(1);
    expect(arnCache.get("conn-1:prod/db")).toBe(exactArn);
  });

  it("scopes to exactly the cached ARN on a cache hit, and skips DescribeSecret entirely", async () => {
    const { client, send } = fakeSts();
    const exactArn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/db-Ab12Cd";
    const arnCache: ArnCache = new Map([["conn-1:prod/db", exactArn]]);
    const describeSend = vi.fn();

    await mintAwsCredential({
      credential,
      path: "prod/db",
      durationSeconds: 900,
      connectionKey: "conn-1",
      arnCache,
      client,
      describeClientFactory: () => ({ send: describeSend }),
    });

    const policy = JSON.parse(send.mock.calls[0]![0].input.Policy);
    expect(policy.Statement[0].Resource).toBe(exactArn);
    expect(policy.Statement[0].Action).toEqual(["secretsmanager:GetSecretValue"]);
    expect(describeSend).not.toHaveBeenCalled();
  });

  it("different connectionKeys with the same path never share a cache entry", async () => {
    const { client } = fakeSts();
    const arnCache: ArnCache = new Map([
      ["conn-1:prod/db", "arn:aws:secretsmanager:us-east-1:111111111111:secret:prod/db-Ab12Cd"],
    ]);
    const { factory } = fakeDescribeClientFactory(
      "arn:aws:secretsmanager:us-east-1:222222222222:secret:prod/db-Zz99Yy",
    );

    await mintAwsCredential({
      credential,
      path: "prod/db",
      durationSeconds: 900,
      connectionKey: "conn-2", // different org's connection, same path string
      arnCache,
      client,
      describeClientFactory: factory,
    });

    expect(arnCache.get("conn-2:prod/db")).toBe(
      "arn:aws:secretsmanager:us-east-1:222222222222:secret:prod/db-Zz99Yy",
    );
    // conn-1's entry is untouched.
    expect(arnCache.get("conn-1:prod/db")).toBe(
      "arn:aws:secretsmanager:us-east-1:111111111111:secret:prod/db-Ab12Cd",
    );
  });

  it("still returns a working credential even if ARN resolution fails - never turns a successful mint into an error", async () => {
    const { client } = fakeSts();
    const arnCache: ArnCache = new Map();
    const failingFactory = () => ({ send: vi.fn().mockRejectedValue(new Error("describe failed")) });

    const result = await mintAwsCredential({
      credential,
      path: "prod/db",
      durationSeconds: 900,
      connectionKey: "conn-1",
      arnCache,
      client,
      describeClientFactory: failingFactory,
    });

    expect(result.accessKeyId).toBe("AKIA_MOCK");
    expect(arnCache.has("conn-1:prod/db")).toBe(false);
  });

  it("works with no arnCache at all - always wildcard-scoped, no DescribeSecret attempted", async () => {
    const { client, send } = fakeSts();

    const result = await mintAwsCredential({
      credential,
      path: "prod/db",
      durationSeconds: 900,
      connectionKey: "conn-1",
      client,
    });

    expect(result.accessKeyId).toBe("AKIA_MOCK");
    const policy = JSON.parse(send.mock.calls[0]![0].input.Policy);
    expect(policy.Statement[0].Resource).toBe(
      "arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/db*",
    );
  });

  it("throws a clean error if STS returns no usable credentials", async () => {
    const fakeClient = { send: vi.fn().mockResolvedValue({}) } as unknown as STSClient;
    await expect(
      mintAwsCredential({
        credential,
        path: "prod/db",
        durationSeconds: 900,
        connectionKey: "conn-1",
        client: fakeClient,
      }),
    ).rejects.toThrow(/no usable credentials/);
  });
});
