import Database from "better-sqlite3";
import type { DbDriver } from "./driver.js";

/**
 * better-sqlite3 is synchronous by design, so every method here resolves
 * immediately rather than doing real async work. That's not a wart: the
 * cost of an already-resolved promise is negligible next to the win of
 * the repo layer having exactly one shape regardless of backend.
 */
export class SqliteDriver implements DbDriver {
  readonly dialect = "sqlite" as const;
  private readonly db: Database.Database;
  /** Guards against `transaction()` being nested - SQLite has savepoints,
   * but nothing in this codebase nests, and silently doing the wrong
   * thing would be worse than refusing. */
  private inTransaction = false;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
  }

  async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.db.prepare(sql).all(...(params as never[])) as T[];
  }

  async get<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    return this.db.prepare(sql).get(...(params as never[])) as T | undefined;
  }

  async run(sql: string, params: unknown[] = []): Promise<void> {
    this.db.prepare(sql).run(...(params as never[]));
  }

  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    if (this.inTransaction) {
      throw new Error("nested transactions are not supported");
    }
    // better-sqlite3's own `db.transaction()` wrapper only accepts
    // synchronous functions, so drive BEGIN/COMMIT directly - `fn` is
    // async by interface even though every SQLite call inside it settles
    // synchronously.
    this.inTransaction = true;
    this.db.exec("BEGIN");
    try {
      const result = await fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    } finally {
      this.inTransaction = false;
    }
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
