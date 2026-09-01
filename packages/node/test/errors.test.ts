import { describe, expect, it } from "vitest";
import { classifyError, isStaleServable, remedyFor } from "../src/providers/errors.js";
import { SecretFetchError } from "../src/providers/base.js";

function awsError(name: string, message = "boom", extra: Record<string, unknown> = {}) {
  return Object.assign(new Error(message), { name, ...extra });
}

describe("classifyError", () => {
  it("treats an exhausted credential chain as auth, not as a missing secret", () => {
    expect(classifyError(awsError("CredentialsProviderError", "Could not load credentials from any providers"))).toBe(
      "auth",
    );
  });

  it("recognises an expired SSO session from the message alone", () => {
    // The SDK surfaces this without a distinctive `name`, which is why
    // message matching exists at all.
    expect(
      classifyError(new Error("The SSO session associated with this profile has expired.")),
    ).toBe("auth");
  });

  it("recognises an expired STS session token", () => {
    expect(classifyError(awsError("ExpiredTokenException"))).toBe("auth");
  });

  it("keeps a missing secret path-specific", () => {
    expect(classifyError(awsError("ResourceNotFoundException"))).toBe("not_found");
  });

  it("keeps AccessDenied path-specific rather than calling it auth", () => {
    // The credentials worked; IAM refused this one secret. Reporting it
    // as an auth failure would send someone to re-login over a policy.
    expect(classifyError(awsError("AccessDeniedException"))).toBe("denied");
  });

  it("classifies throttling and 5xx as transient", () => {
    expect(classifyError(awsError("ThrottlingException"))).toBe("transient");
    expect(classifyError(awsError("Whatever", "boom", { $metadata: { httpStatusCode: 503 } }))).toBe(
      "transient",
    );
  });

  it("maps HTTP status codes when no name is available", () => {
    expect(classifyError({ status: 401 })).toBe("auth");
    expect(classifyError({ status: 403 })).toBe("denied");
    expect(classifyError({ status: 404 })).toBe("not_found");
    expect(classifyError({ status: 429 })).toBe("transient");
  });

  it("falls back to unknown rather than guessing transient", () => {
    // "unknown" is the safe default: the only behaviour keyed off
    // "transient" is retrying and serving stale values, and doing either
    // to a permanent failure makes one clear error into a confusing one.
    expect(classifyError(new Error("something we have never seen"))).toBe("unknown");
  });

  it("survives non-Error throws", () => {
    expect(classifyError("a string")).toBe("unknown");
    expect(classifyError(null)).toBe("unknown");
    expect(classifyError(undefined)).toBe("unknown");
  });
});

describe("isStaleServable", () => {
  it("permits a stale value only for transient faults", () => {
    expect(isStaleServable("transient")).toBe(true);
  });

  it("refuses to paper over auth, denial, absence, or the unknown", () => {
    // Each of these means something changed that an operator must see.
    for (const kind of ["auth", "denied", "not_found", "unknown"] as const) {
      expect(isStaleServable(kind)).toBe(false);
    }
  });
});

describe("remedyFor", () => {
  it("names the profile to re-login when AWS_PROFILE is set", () => {
    const before = process.env.AWS_PROFILE;
    process.env.AWS_PROFILE = "acme-prod";
    try {
      const remedy = remedyFor("auth", "aws", new Error("The SSO session associated with this profile has expired."));
      expect(remedy).toContain("aws sso login --profile acme-prod");
    } finally {
      if (before === undefined) delete process.env.AWS_PROFILE;
      else process.env.AWS_PROFILE = before;
    }
  });

  it("offers no remedy for a path problem - there is nothing to re-run", () => {
    expect(remedyFor("not_found", "aws")).toBeUndefined();
    expect(remedyFor("denied", "aws")).toBeUndefined();
  });
});

describe("SecretFetchError", () => {
  it("does not blame the path for an auth failure", () => {
    const err = new SecretFetchError(
      "aws",
      "prod/db",
      awsError("CredentialsProviderError", "Could not load credentials from any providers"),
    );
    expect(err.kind).toBe("auth");
    // The old message was `failed to fetch secret at "prod/db"`, which
    // reads as four broken secrets when one credential expired.
    expect(err.message).not.toContain("prod/db");
    expect(err.message).toContain("cannot authenticate");
    expect(err.remedy).toBeTruthy();
  });

  it("still names the path for a path-specific failure", () => {
    const err = new SecretFetchError("aws", "prod/db", awsError("ResourceNotFoundException"));
    expect(err.kind).toBe("not_found");
    expect(err.message).toContain("prod/db");
    expect(err.remedy).toBeUndefined();
  });

  it("keeps the original cause reachable for callers that want it", () => {
    const cause = awsError("ThrottlingException");
    expect(new SecretFetchError("aws", "p", cause).cause).toBe(cause);
  });
});
