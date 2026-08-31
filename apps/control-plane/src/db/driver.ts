/**
 * The database seam. Two backends, one interface, because the control
 * plane genuinely has two deployment shapes and they want different
 * things from storage:
 *
 * - **SQLite** — a self-hoster running `docker compose up` shouldn't have
 *   to stand up a database server to try the thing. One file, no network,
 *   no credentials.
 * - **Postgres** — a hosted deployment needs automated backups and
 *   point-in-time recovery, because this database holds other companies'
 *   encrypted vault credentials. Losing it means every org re-onboards
 *   every connection.
 *
 * Everything above this file is async and dialect-agnostic. SQLite's
 * driver is synchronous underneath (better-sqlite3) and simply resolves
 * immediately — the async interface costs it nothing and means the repo
 * layer doesn't fork.
 *
 * Migrations are written in the portable subset both accept:
 * `CURRENT_TIMESTAMP` rather than `datetime('now')`/`now()`, and
 * `ON CONFLICT DO NOTHING` rather than `INSERT OR IGNORE`. The one
 * difference the SQL text can't hide is placeholder syntax (`?` vs
 * `$1`), which `toPostgresPlaceholders` below rewrites.
 */

export type SqlDialect = "sqlite" | "postgres";

export interface DbDriver {
  readonly dialect: SqlDialect;
  /** Rows matching a query. */
  all<T>(sql: string, params?: unknown[]): Promise<T[]>;
  /** First matching row, or undefined. */
  get<T>(sql: string, params?: unknown[]): Promise<T | undefined>;
  /** A statement with no result set. */
  run(sql: string, params?: unknown[]): Promise<void>;
  /** Multi-statement DDL. No parameters - migrations only. */
  exec(sql: string): Promise<void>;
  /** Runs `fn` in a transaction, rolling back if it throws. */
  transaction<T>(fn: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/**
 * Rewrites `?` placeholders to Postgres's `$1, $2, …`. Deliberately naive
 * about strings containing a literal `?`: every query in this codebase is
 * a hand-written constant with no such literal, and parameters are always
 * bound rather than interpolated, so there's no input that reaches here
 * with a `?` inside a quoted string. Keeping it simple beats a SQL
 * tokenizer nobody needs.
 */
export function toPostgresPlaceholders(sql: string): string {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}
