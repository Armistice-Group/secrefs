import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/client.js";
import { ControlPlaneRepo } from "../src/db/repo.js";
import { requireOrgAdmin } from "../src/auth/requireOrgAdmin.js";
import type { WorkOsAuthConfig } from "../src/auth/workos.js";

function setup() {
  const db = openDatabase(":memory:");
  const repo = new ControlPlaneRepo(db);
  const org = repo.createOrganization("Acme Corp");
  const otherOrg = repo.createOrganization("Other Org");
  repo.createOrgAdmin(org.id, "workos_admin_1");
  return { repo, org, otherOrg };
}

const workOsConfig = (verify: (token: string) => Promise<string>): WorkOsAuthConfig => ({
  apiKey: "sk_test_unused",
  clientId: "client_test_unused",
  verify,
});

describe("requireOrgAdmin", () => {
  it("succeeds with no gate at all when no workOsConfig is configured - the documented open-by-default tradeoff", async () => {
    const { repo, org } = setup();
    const result = await requireOrgAdmin(repo, undefined, undefined, org.id);
    expect(result.ok).toBe(true);
  });

  it("401s a missing Authorization header when workOsConfig is configured", async () => {
    const { repo, org } = setup();
    const config = workOsConfig(async () => "workos_admin_1");
    const result = await requireOrgAdmin(repo, config, undefined, org.id);
    expect(result).toMatchObject({ ok: false, status: 401 });
  });

  it("401s an unverifiable token", async () => {
    const { repo, org } = setup();
    const config = workOsConfig(async () => {
      throw new Error("invalid token");
    });
    const result = await requireOrgAdmin(repo, config, "Bearer bad-token", org.id);
    expect(result).toMatchObject({ ok: false, status: 401 });
  });

  it("403s a verified admin who doesn't administer this org", async () => {
    const { repo, org, otherOrg } = setup();
    const config = workOsConfig(async () => "workos_admin_1"); // admin of `org`, not `otherOrg`
    const result = await requireOrgAdmin(repo, config, "Bearer good-token", otherOrg.id);
    expect(result).toMatchObject({ ok: false, status: 403 });
  });

  it("succeeds for a verified admin of the target org", async () => {
    const { repo, org } = setup();
    const config = workOsConfig(async () => "workos_admin_1");
    const result = await requireOrgAdmin(repo, config, "Bearer good-token", org.id);
    expect(result).toEqual({ ok: true });
  });
});

// Sanity check on the repo methods this all leans on, independent of the
// route/auth layer above.
describe("ControlPlaneRepo admin methods", () => {
  it("createOrgAdmin is idempotent - calling it twice for the same pair doesn't duplicate or error", () => {
    const { repo, org } = setup();
    repo.createOrgAdmin(org.id, "workos_admin_1");
    repo.createOrgAdmin(org.id, "workos_admin_1");
    expect(repo.isOrgAdmin("workos_admin_1", org.id)).toBe(true);
  });

  it("listOrganizationsForAdmin returns only orgs the given WorkOS user administers", () => {
    const { repo, org, otherOrg } = setup();
    repo.createOrgAdmin(otherOrg.id, "workos_admin_2");
    const orgs = repo.listOrganizationsForAdmin("workos_admin_1");
    expect(orgs.map((o) => o.id)).toEqual([org.id]);
  });

  it("new organizations default to the free plan", () => {
    const db = openDatabase(":memory:");
    const repo = new ControlPlaneRepo(db);
    const org = repo.createOrganization("New Org");
    expect(org.plan).toBe("free");
    expect(repo.findOrganizationById(org.id)?.plan).toBe("free");
  });
});
