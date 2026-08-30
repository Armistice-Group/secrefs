# @secrefs/control-plane

The org vault-connection + RBAC management service described in
[`docs/control-plane-design.md`](../../docs/control-plane-design.md).

**v1 scope only: AWS Secrets Manager.** No admin UI yet — this is API-only,
matching the phased rollout in the design doc (§11).

## What this is, honestly

This is a working scaffold that proves the model end-to-end, not the
production build described in the design doc. Specifically:

- **Credential custody** uses a single static AES-256-GCM key from an env
  var (`src/crypto/cipher.ts`), not the per-org, KMS-wrapped envelope
  encryption the design doc specifies for production (§4). Swap in a
  `CredentialCipher` implementation backed by a real KMS before this ever
  holds a real org's credentials.
- **Auth is bootstrap-token only** (`src/auth/principal.ts`) — workload
  identity federation (GitHub/GitLab OIDC, the preferred mode per §9)
  isn't implemented yet.
- **No database migrations** — `src/db/schema.ts` is applied idempotently
  on boot. Fine for a single-version scaffold; revisit before there are
  multiple deployed schema versions to reconcile.
- **Secrets Manager ARNs are wildcard-suffixed** (`secretResourceArn` in
  `src/providers/awsSts.ts`) rather than resolved to the exact ARN AWS
  assigned — noted as a known simplification there.

## Run it

```bash
pnpm --filter @secrefs/control-plane build
export SECREFS_CP_CIPHER_KEY=$(node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))")
node dist/server.js
```

Or for local iteration: `pnpm --filter @secrefs/control-plane dev` (same
`SECREFS_CP_CIPHER_KEY` requirement; `tsx watch`, no build step).

| Env var | Default | Purpose |
|---|---|---|
| `PORT` | `8787` | HTTP port |
| `SECREFS_CP_DB_PATH` | `./control-plane.sqlite3` | SQLite file (`:memory:` is also valid, but non-persistent) |
| `SECREFS_CP_CIPHER_KEY` | *(required)* | Base64, must decode to exactly 32 bytes — see the generator command above |

## API surface (v1)

| Route | What |
|---|---|
| `POST /v1/organizations` | Create an org |
| `POST /v1/service-identities` | Create a machine principal; response includes the bootstrap token **once** |
| `POST /v1/connections` | Connect a vault (`provider: "aws"`, `credential: { roleArn, region, externalId? }`) |
| `POST /v1/roles` | Create a role |
| `POST /v1/roles/:roleId/bindings` | Bind a service identity to a role |
| `POST /v1/roles/:roleId/grants` | Grant a role access to a connection, scoped to a `pathPattern` (see `src/rbac/match.ts`) |
| `POST /v1/credentials/mint` | `Authorization: Bearer <bootstrap token>` + `{ alias, path }` → a scoped, short-lived AWS credential, or a `403` with why not |
| `GET /v1/audit` | This org's `AuthorizationEvent` log |

## Tests

```bash
pnpm --filter @secrefs/control-plane test
```

`test/app.e2e.test.ts` drives the full flow above through the real Fastify
app (in-memory SQLite, a mocked STS client) — connect → grant → mint →
deny → audit — and asserts the audit log never contains a secret value or
minted credential.
