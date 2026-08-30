import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkReferences,
  expandKeyValueMap,
  expandProcessEnv,
  SecRefsResolutionError,
} from "../src/resolver.js";
import {
  BaseSecretProvider,
  type ProviderHealth,
  type SecretFetchRequest,
} from "../src/providers/base.js";

class FakeProvider extends BaseSecretProvider {
  readonly name = "fake";

  constructor(private readonly data: Record<string, Record<string, string> | string>) {
    super();
  }

  async fetchOne(request: SecretFetchRequest): Promise<string> {
    if (!(request.path in this.data)) {
      throw new Error(`no such path "${request.path}"`);
    }
    const entry = this.data[request.path] as Record<string, string> | string;

    if (typeof entry === "string") {
      if (request.field) {
        throw new Error(`"${request.path}" is not an object, cannot extract field`);
      }
      return entry;
    }

    if (!request.field) {
      return JSON.stringify(entry);
    }
    const value = entry[request.field];
    if (value === undefined) {
      throw new Error(`field "${request.field}" not found`);
    }
    return value;
  }

  async healthCheck(): Promise<ProviderHealth> {
    return { provider: this.name, ok: true };
  }
}

describe("expandKeyValueMap", () => {
  const providers = {
    fake: new FakeProvider({
      "prod/db": { password: "hunter2", user: "admin" },
      "simple-secret": "plain-value",
    }),
  };

  it("leaves non-reference values untouched", async () => {
    const result = await expandKeyValueMap({ PORT: "3000" }, { providers });
    expect(result).toEqual({ PORT: "3000" });
  });

  it("resolves a reference with a field", async () => {
    const result = await expandKeyValueMap(
      { DB_PASSWORD: "sec://fake/prod/db#password" },
      { providers },
    );
    expect(result).toEqual({ DB_PASSWORD: "hunter2" });
  });

  it("resolves a plain string secret without a field", async () => {
    const result = await expandKeyValueMap({ API_KEY: "sec://fake/simple-secret" }, { providers });
    expect(result).toEqual({ API_KEY: "plain-value" });
  });

  it("resolves multiple references concurrently", async () => {
    const result = await expandKeyValueMap(
      {
        DB_PASSWORD: "sec://fake/prod/db#password",
        DB_USER: "sec://fake/prod/db#user",
        PORT: "3000",
      },
      { providers },
    );
    expect(result).toEqual({ DB_PASSWORD: "hunter2", DB_USER: "admin", PORT: "3000" });
  });

  it("throws a SecRefsResolutionError aggregating all failures", async () => {
    const err = await expandKeyValueMap(
      {
        GOOD: "sec://fake/prod/db#password",
        MISSING_PATH: "sec://fake/does-not-exist#x",
        MISSING_FIELD: "sec://fake/prod/db#does-not-exist",
      },
      { providers },
    ).catch((e) => e);

    expect(err).toBeInstanceOf(SecRefsResolutionError);
    expect((err as SecRefsResolutionError).errors).toHaveLength(2);
    const failedKeys = (err as SecRefsResolutionError).errors.map((e) => e.key).sort();
    expect(failedKeys).toEqual(["MISSING_FIELD", "MISSING_PATH"]);
  });

  it("reports an unknown provider alias as a resolution failure", async () => {
    await expect(
      expandKeyValueMap({ X: "sec://unknown/path#field" }, { providers }),
    ).rejects.toThrow(SecRefsResolutionError);
  });

  it("throws immediately on malformed references in strict mode (default)", async () => {
    await expect(expandKeyValueMap({ X: "sec://" }, { providers })).rejects.toThrow();
  });

  it("leaves malformed references untouched in non-strict mode", async () => {
    const result = await expandKeyValueMap({ X: "sec://" }, { providers, strict: false });
    expect(result).toEqual({ X: "sec://" });
  });
});

describe("expandProcessEnv", () => {
  beforeEach(() => {
    process.env.SECREFS_TEST_SECRET_REF = "sec://fake/prod/db#password";
    process.env.SECREFS_TEST_PLAIN = "unchanged";
  });

  afterEach(() => {
    delete process.env.SECREFS_TEST_SECRET_REF;
    delete process.env.SECREFS_TEST_PLAIN;
  });

  it("mutates process.env in place and returns changed keys", async () => {
    const providers = { fake: new FakeProvider({ "prod/db": { password: "hunter2" } }) };
    const changed = await expandProcessEnv({ providers });

    expect(process.env.SECREFS_TEST_SECRET_REF).toBe("hunter2");
    expect(process.env.SECREFS_TEST_PLAIN).toBe("unchanged");
    expect(changed).toContain("SECREFS_TEST_SECRET_REF");
    expect(changed).not.toContain("SECREFS_TEST_PLAIN");
  });
});

describe("checkReferences", () => {
  it("reports ok:true for resolvable references without leaking values", async () => {
    const providers = { fake: new FakeProvider({ "prod/db": { password: "hunter2" } }) };
    const results = await checkReferences({ DB_PASSWORD: "sec://fake/prod/db#password" }, { providers });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ key: "DB_PASSWORD", provider: "fake", ok: true });
    expect(JSON.stringify(results)).not.toContain("hunter2");
  });

  it("reports ok:false with a diagnostic message for unresolvable references", async () => {
    const providers = { fake: new FakeProvider({}) };
    const results = await checkReferences({ DB_PASSWORD: "sec://fake/missing#password" }, { providers });

    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.message).toBeTruthy();
  });

  it("reports malformed references as failures without throwing", async () => {
    const results = await checkReferences({ X: "sec://" }, { providers: {} });
    expect(results).toEqual([
      expect.objectContaining({ key: "X", provider: "unknown", ok: false }),
    ]);
  });

  it("ignores keys whose values are not secret references", async () => {
    const results = await checkReferences({ PORT: "3000" }, { providers: {} });
    expect(results).toHaveLength(0);
  });
});
