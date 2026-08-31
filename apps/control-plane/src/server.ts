import { buildApp } from "./app.js";
import { createContext } from "./context.js";
import { openDatabase } from "./db/client.js";
import { CipherConfigError, selectCipher } from "./crypto/selectCipher.js";
import { buildOidcConfigFromEnv } from "./auth/oidcConfig.js";
import type { ClerkAuthConfig } from "./auth/clerk.js";

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

const clerkSecretKey = process.env.CLERK_SECRET_KEY;
const clerkConfig: ClerkAuthConfig | undefined = clerkSecretKey ? { secretKey: clerkSecretKey } : undefined;
if (!clerkConfig) {
  console.warn(
    "\n" +
      "⚠️  CLERK_SECRET_KEY is not set - every management endpoint (connections, roles,\n" +
      "   grants, service identities) is UNAUTHENTICATED. Anyone who can reach this\n" +
      "   server's port can create/modify them. Fine for pure local dev on a machine\n" +
      "   only you can reach; set CLERK_SECRET_KEY before exposing this to any shared\n" +
      "   or untrusted network. See apps/control-plane/README.md's \"Admin auth\"\n" +
      "   section.\n",
  );
}

const db = openDatabase(DB_PATH);
const ctx = createContext(db, cipher, { oidcConfig, clerkConfig });
const app = buildApp(ctx);

app
  .listen({ port: PORT, host: "0.0.0.0" })
  .then(() => {
    const oidcNote = oidcConfig
      ? `, OIDC issuers: ${oidcConfig.trustedIssuers.map((t) => t.issuer).join(", ")}`
      : ", OIDC: not configured (bootstrap tokens only)";
    const adminNote = clerkConfig ? ", admin auth: Clerk" : ", admin auth: NONE (see warning above)";
    console.log(`secrefs control plane listening on :${PORT} (db: ${DB_PATH}${oidcNote}${adminNote})`);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
