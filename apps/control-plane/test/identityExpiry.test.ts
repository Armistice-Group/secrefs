import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/client.js";
import { ControlPlaneRepo } from "../src/db/repo.js";
import { generateBootstrapToken, resolvePrincipal } from "../src/auth/principal.js";

async function setup() {
  const db = await openDatabase();
  const repo = new ControlPlaneRepo(db);
  const org = await repo.createOrganization("Acme");
  return { repo, org };
}

const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

describe("service identity expiry", () => {
  it("authenticates an identity with no expiry - the pre-existing default", async () => {
    const { repo, org } = await setup();
    const { token, tokenHash } = generateBootstrapToken();
    await repo.createServiceIdentity(org.id, "ci", tokenHash);

    const principal = await resolvePrincipal(repo, `Bearer ${token}`);
    expect(principal?.name).toBe("ci");
  });

  it("authenticates while the expiry is still in the future", async () => {
    const { repo, org } = await setup();
    const { token, tokenHash } = generateBootstrapToken();
    await repo.createServiceIdentity(org.id, "ci", tokenHash, inDays(30));

    expect((await resolvePrincipal(repo, `Bearer ${token}`))?.name).toBe("ci");
  });

  it("refuses an identity whose expiry has passed", async () => {
    const { repo, org } = await setup();
    const { token, tokenHash } = generateBootstrapToken();
    await repo.createServiceIdentity(org.id, "stale-ci", tokenHash, inDays(-1));

    expect(await resolvePrincipal(repo, `Bearer ${token}`)).toBeUndefined();
  });

  it("fails closed on an unparseable expiry rather than treating it as never", async () => {
    // The admin clearly meant *some* expiry. Reading garbage as "no
    // expiry" would turn a corrupted row into a permanent credential.
    const { repo, org } = await setup();
    const { token, tokenHash } = generateBootstrapToken();
    const identity = await repo.createServiceIdentity(org.id, "ci", tokenHash, "not-a-date");
    expect(identity.expires_at).toBe("not-a-date");

    expect(await resolvePrincipal(repo, `Bearer ${token}`)).toBeUndefined();
  });

  it("records last_used_at on a successful authentication", async () => {
    const { repo, org } = await setup();
    const { token, tokenHash } = generateBootstrapToken();
    const created = await repo.createServiceIdentity(org.id, "ci", tokenHash);
    expect(created.last_used_at).toBeNull();

    await resolvePrincipal(repo, `Bearer ${token}`);

    const after = await repo.findServiceIdentityById(created.id);
    expect(after?.last_used_at).toBeTruthy();
    expect(Number.isNaN(Date.parse(after!.last_used_at!))).toBe(false);
  });

  it("leaves last_used_at untouched when authentication fails", async () => {
    // Otherwise "last used" would really mean "last attempted", and an
    // attacker probing a revoked token would keep it looking alive.
    const { repo, org } = await setup();
    const { tokenHash } = generateBootstrapToken();
    const created = await repo.createServiceIdentity(org.id, "ci", tokenHash, inDays(-1));

    await resolvePrincipal(repo, `Bearer ${generateBootstrapToken().token}`);

    expect((await repo.findServiceIdentityById(created.id))?.last_used_at).toBeNull();
  });

  it("lists expiry and last-use so an admin can find forgotten identities", async () => {
    const { repo, org } = await setup();
    await repo.createServiceIdentity(org.id, "never-used", generateBootstrapToken().tokenHash);

    const [identity] = await repo.listServiceIdentities(org.id);
    expect(identity).toMatchObject({ name: "never-used", expires_at: null, last_used_at: null });
  });

  it("touchServiceIdentityLastUsed is idempotent and moves the timestamp forward", async () => {
    const { repo, org } = await setup();
    const created = await repo.createServiceIdentity(org.id, "ci", generateBootstrapToken().tokenHash);

    await repo.touchServiceIdentityLastUsed(created.id, "2026-01-01T00:00:00.000Z");
    await repo.touchServiceIdentityLastUsed(created.id, "2026-06-01T00:00:00.000Z");

    expect((await repo.findServiceIdentityById(created.id))?.last_used_at).toBe(
      "2026-06-01T00:00:00.000Z",
    );
  });
});
