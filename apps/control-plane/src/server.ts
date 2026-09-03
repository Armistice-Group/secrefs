import { buildApp } from "./app.js";
import { createContext } from "./context.js";
import { openDatabase } from "./db/client.js";
import { CipherConfigError, selectCipher } from "./crypto/selectCipher.js";
import { buildOidcConfigFromEnv } from "./auth/oidcConfig.js";
import type { WorkOsAuthConfig } from "./auth/workos.js";

const PORT = Number(process.env.PORT ?? 8787);
const DB_PATH = process.env.SECREFS_CP_DB_PATH ?? "./control-plane.sqlite3";

let cipher;
try {
  cipher = selectCipher(process.env);
} catch (err) {
  if (err instanceof CipherConfigError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}

let oidcConfig;
try {
  oidcConfig = buildOidcConfigFromEnv(process.env);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

const workOsApiKey = process.env.WORKOS_API_KEY;
const workOsClientId = process.env.WORKOS_CLIENT_ID;
const workOsConfig: WorkOsAuthConfig | undefined =
  workOsApiKey && workOsClientId ? { apiKey: workOsApiKey, clientId: workOsClientId } : undefined;
if (!workOsConfig) {
  console.warn(
    "\n" +
      "⚠️  WORKOS_API_KEY and/or WORKOS_CLIENT_ID is not set - every management\n" +
      "   endpoint (connections, roles, grants, service identities) is UNAUTHENTICATED.\n" +
      "   Anyone who can reach this server's port can create/modify them. Fine for\n" +
      "   pure local dev on a machine only you can reach; set both before exposing\n" +
      "   this to any shared or untrusted network. See\n" +
      "   apps/control-plane/README.md's \"Admin auth\" section.\n",
  );
}

// Comma-separated origins the admin console is served from, e.g.
// "http://localhost:3001" locally or "https://admin.example.com" in a
// real deployment. Unset means no CORS headers at all - correct unless
// you're actually running the console. See app.ts's BuildAppOptions.
const corsOrigins = (process.env.SECREFS_CP_CORS_ORIGINS ?? "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

// Postgres when DATABASE_URL is set (hosted deployments - see infra/),
// otherwise the SQLite file at SECREFS_CP_DB_PATH. Nothing to switch on:
// having provisioned a database is the signal that you meant to use it.
const databaseUrl = process.env.DATABASE_URL;
// Off only for a local Postgres container with a self-signed cert. Never
// set this against RDS - it disables server certificate verification.
const databaseSsl = process.env.SECREFS_CP_DB_SSL !== "false";

const db = await openDatabase({
  databaseUrl,
  sqlitePath: DB_PATH,
  ssl: databaseSsl,
});
const ctx = createContext(db, cipher, { oidcConfig, workOsConfig });
// Serving the console from this origin lets its session live in an
// HttpOnly cookie instead of localStorage, and makes CORS unnecessary.
// Unset leaves this an API-only service, which is what a deployment
// running the console elsewhere wants.
const consoleDir = process.env.SECREFS_CP_CONSOLE_DIR || undefined;

const app = buildApp(ctx, { corsOrigins, consoleDir });

app
  .listen({ port: PORT, host: "0.0.0.0" })
  .then(() => {
    const oidcNote = oidcConfig
      ? `, OIDC issuers: ${oidcConfig.trustedIssuers.map((t) => t.issuer).join(", ")}`
      : ", OIDC: not configured (bootstrap tokens only)";
    const adminNote = workOsConfig ? ", admin auth: WorkOS" : ", admin auth: NONE (see warning above)";
    const corsNote = corsOrigins.length ? `, CORS: ${corsOrigins.join(", ")}` : "";
    const consoleNote = consoleDir ? `, console: ${consoleDir}` : "";
    // Never log DATABASE_URL itself - it carries the password.
    const dbNote = databaseUrl ? "postgres" : DB_PATH;
    console.log(
      `secrefs control plane listening on :${PORT} (db: ${dbNote}${oidcNote}${adminNote}${corsNote}${consoleNote})`,
    );
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
