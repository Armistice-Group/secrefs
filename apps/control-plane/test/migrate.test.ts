import { describe, expect, it, vi } from "vitest";
import { runMigrations } from "../src/db/migrate.js";
import type { Migration } from "../src/db/migrations/types.js";
import { MIGRATIONS } from "../src/db/migrations/index.js";
import { openDatabase } from "../src/db/client.js";
import { SqliteDriver } from "../src/db/sqliteDriver.js";
import type { DbDriver } from "../src/db/driver.js";

describe("runMigrations", () => {
  it("applies every migration in order and records each as applied", async () => {
    const db: DbDriver = new SqliteDriver(":memory:");
    const order: string[] = [];
    const migrations: Migration[] = [
      {
        id: "0001_a",
        up: async (d) => {
          await d.exec("CREATE TABLE a (id TEXT)");
          order.push("0001_a");
        },
      },
      {
        id: "0002_b",
        up: async (d) => {
          await d.exec("CREATE TABLE b (id TEXT)");
          order.push("0002_b");
        },
      },
    ];

    const ran = await runMigrations(db, migrations);

    expect(ran).toEqual(["0001_a", "0002_b"]);
    expect(order).toEqual(["0001_a", "0002_b"]);
    const applied = await db.all<{ id: string }>("SELECT id FROM _migrations ORDER BY id");
    expect(applied.map((r) => r.id)).toEqual(["0001_a", "0002_b"]);
    await db.close();
  });

  it("is idempotent - a second call applies nothing new", async () => {
    const db: DbDriver = new SqliteDriver(":memory:");
    const up = vi.fn(async (d: DbDriver) => {
      await d.exec("CREATE TABLE a (id TEXT)");
    });
    const migrations: Migration[] = [{ id: "0001_a", up }];

    expect(await runMigrations(db, migrations)).toEqual(["0001_a"]);
    expect(await runMigrations(db, migrations)).toEqual([]);
    expect(up).toHaveBeenCalledTimes(1);
    await db.close();
  });

  it("only runs migrations not already recorded, even out of a larger list", async () => {
    const db: DbDriver = new SqliteDriver(":memory:");
    const first: Migration = { id: "0001_a", up: async (d) => d.exec("CREATE TABLE a (id TEXT)") };
    await runMigrations(db, [first]);

    const second: Migration = { id: "0002_b", up: async (d) => d.exec("CREATE TABLE b (id TEXT)") };
    expect(await runMigrations(db, [first, second])).toEqual(["0002_b"]);
    await db.close();
  });

  it("rolls back a failing migration entirely and does not record it as applied", async () => {
    const db: DbDriver = new SqliteDriver(":memory:");
    const migrations: Migration[] = [
      {
        id: "0001_bad",
        up: async (d) => {
          await d.exec("CREATE TABLE a (id TEXT)");
          throw new Error("boom");
        },
      },
    ];

    await expect(runMigrations(db, migrations)).rejects.toThrow("boom");

    // The CREATE TABLE inside the failed transaction was rolled back too.
    const tables = await db.all("SELECT name FROM sqlite_master WHERE type='table' AND name='a'");
    expect(tables).toHaveLength(0);
    expect(await db.all("SELECT id FROM _migrations")).toHaveLength(0);
    await db.close();
  });
});

describe("openDatabase (SQLite)", () => {
  it("brings a fresh database up to the current schema via the real migration list", async () => {
    const db = await openDatabase();
    const tables = (
      await db.all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      )
    ).map((r) => r.name);

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
        "_migrations",
      ]),
    );
    await db.close();
  });

  it("adopts a file created by the pre-migration scaffold without crashing", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "secrefs-cp-adopt-test-"));
    const dbPath = join(dir, "pre-existing.sqlite3");

    try {
      // Recreates what the original raw db.exec(SCHEMA_SQL) produced:
      // every table 0001_init also creates, but no _migrations table.
      const preExisting = new SqliteDriver(dbPath);
      await preExisting.exec(`
        CREATE TABLE organizations (id TEXT PRIMARY KEY, name TEXT NOT NULL);
        CREATE TABLE service_identities (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, name TEXT NOT NULL, bootstrap_token_hash TEXT NOT NULL UNIQUE);
        CREATE TABLE vault_connections (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, provider TEXT NOT NULL, alias TEXT NOT NULL, encrypted_credential TEXT NOT NULL);
        CREATE TABLE roles (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, name TEXT NOT NULL);
        CREATE TABLE role_bindings (role_id TEXT NOT NULL, service_identity_id TEXT NOT NULL);
        CREATE TABLE grants (id TEXT PRIMARY KEY, role_id TEXT NOT NULL, vault_connection_id TEXT NOT NULL, path_pattern TEXT NOT NULL, max_ttl_seconds INTEGER NOT NULL);
        CREATE TABLE authorization_events (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, service_identity_id TEXT NOT NULL, alias TEXT NOT NULL, path TEXT NOT NULL, decision TEXT NOT NULL);
      `);
      await preExisting.run("INSERT INTO organizations (id, name) VALUES (?, ?)", [
        "org-1",
        "Pre-existing Org",
      ]);
      await preExisting.close();

      // The real path: an operator upgrades and restarts against the same file.
      const reopened = await openDatabase({ sqlitePath: dbPath });

      const org = await reopened.get<{ name: string }>(
        "SELECT name FROM organizations WHERE id = ?",
        ["org-1"],
      );
      expect(org?.name).toBe("Pre-existing Org");

      const applied = (
        await reopened.all<{ id: string }>("SELECT id FROM _migrations ORDER BY id")
      ).map((r) => r.id);
      expect(applied).toEqual(MIGRATIONS.map((m) => m.id));
      await reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
