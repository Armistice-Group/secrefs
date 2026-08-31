import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/client.js";
import { ControlPlaneRepo, FREE_TIER_CONNECTION_LIMIT } from "../src/db/repo.js";
import { MIGRATIONS } from "../src/db/migrations/index.js";
import { toPostgresPlaceholders } from "../src/db/driver.js";
import { authorize } from "../src/rbac/authorize.js";
import { generateBootstrapToken } from "../src/auth/principal.js";
import type { DbDriver } from "../src/db/driver.js";

/**
 * The migrations and repo layer run against a real Postgres, not a mock -
 * the whole point of the driver abstraction is that the SQL is portable,
 * and only a real server can prove that. SQLite-only tests would pass
 * happily while the hosted deployment fell over on a dialect difference.
 *
 * Skipped unless SECREFS_TEST_DATABASE_URL points at a throwaway
 * database, so a plain `pnpm test` on a laptop with no Postgres still
 * works. CI and anyone touching db/ should set it. Start one with:
 *   docker run -d --name pg -e POSTGRES_PASSWORD=test \
 *     -e POSTGRES_DB=secrefs_test -p 55433:5432 postgres:16-alpine
 *   SECREFS_TEST_DATABASE_URL=postgres://postgres:test@localhost:55433/secrefs_test
 */
const DATABASE_URL = process.env.SECREFS_TEST_DATABASE_URL;
const describeIfPostgres = DATABASE_URL ? describe : describe.skip;

describe("toPostgresPlaceholders", () => {
  it("numbers placeholders in order", () => {
    expect(toPostgresPlaceholders("INSERT INTO t (a, b) VALUES (?, ?)")).toBe(
      "INSERT INTO t (a, b) VALUES ($1, $2)",
    );
  });

  it("leaves parameterless SQL untouched", () => {
    expect(toPostgresPlaceholders("SELECT 1")).toBe("SELECT 1");
  });

  it("keeps numbering across a longer statement", () => {
    const sql = "INSERT INTO t (a,b,c,d,e,f,g,h) VALUES (?,?,?,?,?,?,?,?)";
    expect(toPostgresPlaceholders(sql)).toContain("$8");
    expect(toPostgresPlaceholders(sql)).not.toContain("?");
  });
});

describeIfPostgres("Postgres backend", () => {
  let db: DbDriver;
  let repo: ControlPlaneRepo;

  beforeAll(async () => {
    // Start from a clean schema so a re-run isn't polluted by the last one.
    const bootstrap = await openDatabase({ databaseUrl: DATABASE_URL, ssl: false });
    await bootstrap.exec("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await bootstrap.close();

    db = await openDatabase({ databaseUrl: DATABASE_URL, ssl: false });
    repo = new ControlPlaneRepo(db);
  });

  afterAll(async () => {
    await db?.close();
  });

  it("runs every real migration against Postgres", async () => {
    const applied = (await db.all<{ id: string }>("SELECT id FROM _migrations ORDER BY id")).map(
      (r) => r.id,
    );
    expect(applied).toEqual(MIGRATIONS.map((m) => m.id));
  });

  it("creates the full schema", async () => {
    const tables = (
      await db.all<{ table_name: string }>(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
      )
    ).map((r) => r.table_name);

    expect(tables).toEqual(
      expect.arrayContaining([
        "organizations",
        "service_identities",
        "vault_connections",
        "roles",
        "role_bindings",
        "grants",
        "authorization_events",
        "oidc_bindings",
        "org_admins",
      ]),
    );
  });

  it("round-trips an org, and defaults its plan to free", async () => {
    const org = await repo.createOrganization("Acme Corp");
    expect(org.plan).toBe("free");

    const found = await repo.findOrganizationById(org.id);
    expect(found).toMatchObject({ id: org.id, name: "Acme Corp", plan: "free" });
  });

  it("ON CONFLICT DO NOTHING makes createOrgAdmin idempotent (the INSERT OR IGNORE replacement)", async () => {
    const org = await repo.createOrganization("Idempotent Org");
    await repo.createOrgAdmin(org.id, "user_1");
    await repo.createOrgAdmin(org.id, "user_1");

    expect(await repo.isOrgAdmin("user_1", org.id)).toBe(true);
    const admins = await db.all("SELECT id FROM org_admins WHERE org_id = ? AND workos_user_id = ?", [
      org.id,
      "user_1",
    ]);
    expect(admins).toHaveLength(1);
  });

  it("counts connections correctly (COUNT(*) comes back as a usable number)", async () => {
    // Postgres returns bigint for COUNT(*), which node-postgres hands back
    // as a string by default - if that ever regresses, the free-tier limit
    // comparison silently stops working.
    const org = await repo.createOrganization("Counting Org");
    expect(await repo.countVaultConnections(org.id)).toBe(0);

    await repo.createVaultConnection(org.id, "aws", "aws-prod", "ciphertext");
    const count = await repo.countVaultConnections(org.id);
    expect(count).toBe(1);
    expect(typeof count).toBe("number");
    expect(count >= FREE_TIER_CONNECTION_LIMIT).toBe(false);
  });

  it("resolves a full RBAC allow through authorize()", async () => {
    const org = await repo.createOrganization("RBAC Org");
    const connection = await repo.createVaultConnection(org.id, "aws", "aws-prod", "ciphertext");
    const role = await repo.createRole(org.id, "ci-deploy");
    const { tokenHash } = generateBootstrapToken();
    const identity = await repo.createServiceIdentity(org.id, "bot", tokenHash);

    await repo.bindServiceIdentityToRole(role.id, identity.id);
    await repo.createGrant(role.id, connection.id, "prod/*", 900);

    const decision = await authorize(repo, {
      orgId: org.id,
      serviceIdentityId: identity.id,
      alias: "aws-prod",
      path: "prod/db",
    });

    expect(decision.allowed).toBe(true);
    if (decision.allowed) expect(decision.ttlSeconds).toBe(900);
  });

  it("denies an out-of-scope path with a reason", async () => {
    const org = await repo.createOrganization("Deny Org");
    const connection = await repo.createVaultConnection(org.id, "aws", "aws-prod", "ciphertext");
    const role = await repo.createRole(org.id, "ci-deploy");
    const { tokenHash } = generateBootstrapToken();
    const identity = await repo.createServiceIdentity(org.id, "bot", tokenHash);
    await repo.bindServiceIdentityToRole(role.id, identity.id);
    await repo.createGrant(role.id, connection.id, "prod/db", 900);

    const decision = await authorize(repo, {
      orgId: org.id,
      serviceIdentityId: identity.id,
      alias: "aws-prod",
      path: "prod/billing",
    });

    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toMatch(/no grant authorizes/);
  });

  it("writes and reads back the audit log", async () => {
    const org = await repo.createOrganization("Audit Org");
    const { tokenHash } = generateBootstrapToken();
    const identity = await repo.createServiceIdentity(org.id, "bot", tokenHash);

    await repo.recordAuthorizationEvent({
      orgId: org.id,
      serviceIdentityId: identity.id,
      vaultConnectionId: null,
      alias: "aws-prod",
      path: "prod/db",
      decision: "deny",
      reason: "no grant authorizes it",
    });

    const events = (await repo.listAuthorizationEvents(org.id)) as { decision: string; reason: string }[];
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ decision: "deny", reason: "no grant authorizes it" });
  });

  it("rolls a failed transaction back", async () => {
    await expect(
      db.transaction(async () => {
        await db.run("INSERT INTO organizations (id, name) VALUES (?, ?)", [
          randomBytes(16).toString("hex"),
          "Doomed Org",
        ]);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const found = await db.all("SELECT id FROM organizations WHERE name = ?", ["Doomed Org"]);
    expect(found).toHaveLength(0);
  });
});
