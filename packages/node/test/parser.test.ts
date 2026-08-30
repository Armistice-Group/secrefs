import { describe, expect, it } from "vitest";
import { isSecretRef, parseSecretRef, SecRefParseError, tryParseSecretRef } from "../src/parser.js";

describe("parseSecretRef", () => {
  it("parses a simple aws reference with a field", () => {
    const ref = parseSecretRef("sec://aws/prod/db#password");
    expect(ref).toEqual({
      raw: "sec://aws/prod/db#password",
      provider: "aws",
      path: "prod/db",
      field: "password",
    });
  });

  it("parses a vault kv v2 style reference", () => {
    const ref = parseSecretRef("sec://vault/secret/data/stripe#key");
    expect(ref.provider).toBe("vault");
    expect(ref.path).toBe("secret/data/stripe");
    expect(ref.field).toBe("key");
  });

  it("parses a local reference", () => {
    const ref = parseSecretRef("sec://local/mock-db#password");
    expect(ref.provider).toBe("local");
    expect(ref.path).toBe("mock-db");
    expect(ref.field).toBe("password");
  });

  it("supports references without a field fragment", () => {
    const ref = parseSecretRef("sec://aws/prod/api-key");
    expect(ref.field).toBeUndefined();
    expect(ref.path).toBe("prod/api-key");
  });

  it("supports dotted nested field paths", () => {
    const ref = parseSecretRef("sec://vault/secret/data/stripe#nested.value");
    expect(ref.field).toBe("nested.value");
  });

  it("lowercases the provider alias", () => {
    const ref = parseSecretRef("sec://AWS/prod/db#password");
    expect(ref.provider).toBe("aws");
  });

  it("trims surrounding whitespace before parsing", () => {
    const ref = parseSecretRef("  sec://aws/prod/db#password  ");
    expect(ref.provider).toBe("aws");
  });

  it("rejects strings that do not start with sec://", () => {
    expect(() => parseSecretRef("env://aws/prod/db")).toThrow(SecRefParseError);
  });

  it("rejects references with no provider", () => {
    expect(() => parseSecretRef("sec:///prod/db")).toThrow(SecRefParseError);
  });

  it("rejects references with no path", () => {
    expect(() => parseSecretRef("sec://aws")).toThrow(SecRefParseError);
  });

  it("rejects references containing whitespace", () => {
    expect(() => parseSecretRef("sec://aws/prod db#password")).toThrow(SecRefParseError);
  });

  it("rejects non-string input", () => {
    expect(() => parseSecretRef(1234)).toThrow(SecRefParseError);
  });

  it("includes the raw value and reason on the thrown error", () => {
    try {
      parseSecretRef("sec://aws");
      expect.unreachable("expected parseSecretRef to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(SecRefParseError);
      expect((err as SecRefParseError).raw).toBe("sec://aws");
      expect((err as SecRefParseError).reason).toContain("path");
    }
  });
});

describe("tryParseSecretRef", () => {
  it("returns the parsed ref on success", () => {
    expect(tryParseSecretRef("sec://aws/prod/db#password")?.provider).toBe("aws");
  });

  it("returns null instead of throwing on failure", () => {
    expect(tryParseSecretRef("not-a-ref")).toBeNull();
  });
});

describe("isSecretRef", () => {
  it("returns true for sec:// strings", () => {
    expect(isSecretRef("sec://aws/prod/db#password")).toBe(true);
  });

  it("returns false for plain strings", () => {
    expect(isSecretRef("just-a-value")).toBe(false);
  });

  it("returns false for non-strings", () => {
    expect(isSecretRef(undefined)).toBe(false);
    expect(isSecretRef(42)).toBe(false);
  });
});
