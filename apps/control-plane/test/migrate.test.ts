import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { runMigrations } from "../src/db/migrate.js";
import type { Migration } from "../src/db/migrations/types.js";
import { MIGRATIONS } from "../src/db/migrations/index.js";
import { openDatabase } from "../src/db/client.js";

describe("runMigrations", () => {
  it("applies every migration in order and records each as applied", () => {
    const db = new Database(":memory:");
    const order: string[] = [];
    const migrations: Migration[] = [
      { id: "0001_a", up: (d) => { d.exec("CREATE TABLE a (id TEXT)"); order.push("0001_a"); } },
      { id: "0002_b", up: (d) => { d.exec("CREATE TABLE b (id TEXT)"); order.push("0002_b"); } },
    ];

    const ran = runMigrations(db, migrations);

    expect(ran).toEqual(["0001_a", "0002_b"]);
    expect(order).toEqual(["0001_a", "0002_b"]);
    const applied = db.prepare("SELECT id FROM _migrations ORDER BY id").all() as { id: string }[];
    expect(applied.map((r) => r.id)).toEqual(["0001_a", "0002_b"]);
  });

  it("is idempotent - a second call applies nothing new", () => {
    const db = new Database(":memory:");
    const up = vi.fn((d: Database.Database) => d.exec("CREATE TABLE a (id TEXT)"));
    const migrations: Migration[] = [{ id: "0001_a", up }];

    expect(runMigrations(db, migrations)).toEqual(["0001_a"]);
    expect(runMigrations(db, migrations)).toEqual([]);
    expect(up).toHaveBeenCalledTimes(1);
  });

  it("only runs migrations not already recorded, even out of a larger list", () => {
    const db = new Database(":memory:");
    const first: Migration = { id: "0001_a", up: (d) => d.exec("CREATE TABLE a (id TEXT)") };
    runMigrations(db, [first]);

    const second: Migration = { id: "0002_b", up: (d) => d.exec("CREATE TABLE b (id TEXT)") };
    const ran = runMigrations(db, [first, second]);

    expect(ran).toEqual(["0002_b"]);
  });

  it("rolls back a failing migration entirely and does not record it as applied", () => {
    const db = new Database(":memory:");
    const migrations: Migration[] = [
      {
        id: "0001_bad",
        up: (d) => {
          d.exec("CREATE TABLE a (id TEXT)");
          throw new Error("boom");
        },
      },
    ];

    expect(() => runMigrations(db, migrations)).toThrow("boom");

    // The CREATE TABLE inside the failed transaction was rolled back too.
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='a'")
      .all();
    expect(tables).toHaveLength(0);

    const applied = db.prepare("SELECT id FROM _migrations").all();
    expect(applied).toHaveLength(0);
  });
});

describe("openDatabase", () => {
  it("brings a fresh database up to the current schema via the real migration list", () => {
    const db = openDatabase(":memory:");
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {
        name: string;
      }[]
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
        "_migrations",
      ]),
    );
  });

  it("openDatabase() adopts a file created by the pre-migration scaffold (PR #3) without crashing", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "secrefs-cp-adopt-test-"));
    const dbPath = join(dir, "pre-existing.sqlite3");

    try {
      // Recreates exactly what schema.ts's raw db.exec(SCHEMA_SQL)
      // produced before migrations existed: every table 0001_init also
      // creates, but no _migrations table recording that at all.
      const preExisting = new Database(dbPath);
      preExisting.exec(`
        CREATE TABLE organizations (id TEXT PRIMARY KEY, name TEXT NOT NULL);
        CREATE TABLE service_identities (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, name TEXT NOT NULL, bootstrap_token_hash TEXT NOT NULL UNIQUE);
        CREATE TABLE vault_connections (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, provider TEXT NOT NULL, alias TEXT NOT NULL, encrypted_credential TEXT NOT NULL);
        CREATE TABLE roles (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, name TEXT NOT NULL);
        CREATE TABLE role_bindings (role_id TEXT NOT NULL, service_identity_id TEXT NOT NULL);
        CREATE TABLE grants (id TEXT PRIMARY KEY, role_id TEXT NOT NULL, vault_connection_id TEXT NOT NULL, path_pattern TEXT NOT NULL, max_ttl_seconds INTEGER NOT NULL);
        CREATE TABLE authorization_events (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, service_identity_id TEXT NOT NULL, alias TEXT NOT NULL, path TEXT NOT NULL, decision TEXT NOT NULL);
      `);
      preExisting
        .prepare("INSERT INTO organizations (id, name) VALUES ('org-1', 'Pre-existing Org')")
        .run();
      preExisting.close();

      // The real code path: an operator upgrades and restarts, and
      // openDatabase() opens the exact same file this server was already
      // running against.
      let reopened: ReturnType<typeof openDatabase>;
      expect(() => {
        reopened = openDatabase(dbPath);
      }).not.toThrow();

      // The org row from "before" is untouched, 0001_init is recorded as
      // applied without having been re-run (which would have crashed on
      // CREATE TABLE organizations), and every migration after it still
      // applies normally.
      const org = reopened!.prepare("SELECT name FROM organizations WHERE id = 'org-1'").get() as {
        name: string;
      };
      expect(org.name).toBe("Pre-existing Org");
      const applied = (reopened!.prepare("SELECT id FROM _migrations ORDER BY id").all() as { id: string }[]).map(
        (r) => r.id,
      );
      expect(applied).toEqual(MIGRATIONS.map((m) => m.id));
      reopened!.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("running openDatabase against an already-migrated file is idempotent", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "secrefs-cp-migrate-test-"));
    const dbPath = join(dir, "test.sqlite3");

    try {
      const first = openDatabase(dbPath);
      first.close();
      // Reopening should find every migration already applied and change
      // nothing - this is exactly what happens on every real server restart.
      const second = openDatabase(dbPath);
      const appliedCount = (
        second.prepare("SELECT COUNT(*) as n FROM _migrations").get() as { n: number }
      ).n;
      expect(appliedCount).toBe(MIGRATIONS.length);
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
