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

const db = openDatabase(DB_PATH);
const ctx = createContext(db, cipher, { oidcConfig, workOsConfig });
const app = buildApp(ctx);

app
  .listen({ port: PORT, host: "0.0.0.0" })
  .then(() => {
    const oidcNote = oidcConfig
      ? `, OIDC issuers: ${oidcConfig.trustedIssuers.map((t) => t.issuer).join(", ")}`
      : ", OIDC: not configured (bootstrap tokens only)";
    const adminNote = workOsConfig ? ", admin auth: WorkOS" : ", admin auth: NONE (see warning above)";
    console.log(`secrefs control plane listening on :${PORT} (db: ${DB_PATH}${oidcNote}${adminNote})`);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
