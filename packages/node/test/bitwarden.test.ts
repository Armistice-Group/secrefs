import { beforeEach, describe, expect, it, vi } from "vitest";
import { BitwardenProvider, type BitwardenClientLike } from "../src/providers/bitwarden.js";

const SECRET_UUID = "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d";
const OTHER_UUID = "6ec0bd7f-11c0-43da-975e-2a8ad9ebae0b";

function fakeClient(overrides: Partial<BitwardenClientLike> = {}): {
  client: BitwardenClientLike;
  login: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
} {
  const login = vi.fn().mockResolvedValue(undefined);
  const get = vi.fn().mockResolvedValue({ value: JSON.stringify({ password: "hunter2" }) });
  const list = vi.fn().mockResolvedValue({
    data: [
      { id: SECRET_UUID, key: "prod-db" },
      { id: OTHER_UUID, key: "prod-api-key" },
    ],
  });
  const client: BitwardenClientLike = {
    auth: () => ({ loginAccessToken: login }),
    secrets: () => ({ get, list }),
    ...overrides,
  };
  return { client, login, get, list };
}

describe("BitwardenProvider", () => {
  let fake: ReturnType<typeof fakeClient>;
  let provider: BitwardenProvider;

  beforeEach(() => {
    fake = fakeClient();
    provider = new BitwardenProvider({
      accessToken: "0.mock-access-token",
      organizationId: "org-1",
      client: fake.client,
    });
  });

  it("fetches a secret by UUID directly, extracting the requested field", async () => {
    const value = await provider.fetchOne({ path: SECRET_UUID, field: "password" });
    expect(value).toBe("hunter2");
    expect(fake.login).toHaveBeenCalledWith("0.mock-access-token", undefined);
    expect(fake.get).toHaveBeenCalledWith(SECRET_UUID);
    // A UUID path never needs the name->id lookup.
    expect(fake.list).not.toHaveBeenCalled();
  });

  it("resolves a secret by name via list(), when organizationId is configured", async () => {
    const value = await provider.fetchOne({ path: "prod-db", field: "password" });
    expect(value).toBe("hunter2");
    expect(fake.get).toHaveBeenCalledWith(SECRET_UUID);
    expect(fake.list).toHaveBeenCalledWith("org-1");
  });

  it("caches the name->id map - a second name-based lookup doesn't call list() again", async () => {
    await provider.fetchOne({ path: "prod-db", field: "password" });
    await provider.fetchOne({ path: "prod-api-key", field: "password" });
    expect(fake.list).toHaveBeenCalledTimes(1);
  });

  it("only logs in once across multiple fetches", async () => {
    await provider.fetchOne({ path: SECRET_UUID, field: "password" });
    await provider.fetchOne({ path: SECRET_UUID, field: "password" });
    expect(fake.login).toHaveBeenCalledTimes(1);
  });

  it("rejects a non-UUID path when no organizationId is configured", async () => {
    const noOrg = new BitwardenProvider({ accessToken: "token", client: fake.client });
    await expect(noOrg.fetchOne({ path: "prod-db" })).rejects.toThrow(/no organizationId is configured/);
  });

  it("errors clearly when a name has no matching secret", async () => {
    await expect(provider.fetchOne({ path: "does-not-exist" })).rejects.toThrow(
      /no secret named "does-not-exist"/,
    );
  });

  it("passes a stateFile through to login only when explicitly configured", async () => {
    const withState = new BitwardenProvider({
      accessToken: "token",
      client: fake.client,
      stateFile: "/tmp/bws-state",
    });
    await withState.fetchOne({ path: SECRET_UUID });
    expect(fake.login).toHaveBeenCalledWith("token", "/tmp/bws-state");
  });

  it("throws a clear error when BWS_ACCESS_TOKEN is not set and none was passed", async () => {
    const noToken = new BitwardenProvider({});
    await expect(noToken.fetchOne({ path: SECRET_UUID })).rejects.toThrow(/BWS_ACCESS_TOKEN is not set/);
  });

  it("healthCheck reports ok:false (not a throw) when login fails", async () => {
    const failing = fakeClient({ auth: () => ({ loginAccessToken: vi.fn().mockRejectedValue(new Error("bad token")) }) });
    const badProvider = new BitwardenProvider({ accessToken: "bad", client: failing.client });
    const health = await badProvider.healthCheck();
    expect(health.ok).toBe(false);
    expect(health.message).toMatch(/bad token/);
  });

  it("healthCheck reports ok:true on successful login", async () => {
    const health = await provider.healthCheck();
    expect(health.ok).toBe(true);
  });
});
