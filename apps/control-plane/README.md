# @secrefs/control-plane

The org vault-connection + RBAC management service described in
[`docs/control-plane-design.md`](../../docs/control-plane-design.md).

**v1 scope: AWS Secrets Manager and Bitwarden Secrets Manager.** No admin
UI yet — this is API-only, matching the phased rollout in the design doc
(§11).

**AWS and Bitwarden are not the same shape of "credential broker."** AWS
mints a fresh, narrowly-scoped, short-lived credential per request
(`sts:AssumeRole` + an inline session policy). Bitwarden's public API
doesn't support that — access tokens are pre-provisioned per machine
account, each with a fixed scope and expiration set at creation. So for
Bitwarden this is a credential *distributor*, not a *minter*: still
authenticated, RBAC'd, and audited, but the token you get back is the
org's one stored token as-is, not freshly re-scoped to your request. See
`src/providers/bitwarden.ts` and design doc §8 for the full reasoning.

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

## Run it locally (no Docker)

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

## Self-hosting

There's no SecRefs-hosted version of this yet — today, self-hosting *is*
how you run a control plane at all. `Dockerfile` and `docker-compose.yml`
in this directory are a real, tested deployment path, not aspirational:

```bash
cd apps/control-plane
export SECREFS_CP_CIPHER_KEY=$(node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))")
docker compose up --build
```

Listens on `:8787`. Data — org connections, roles, grants, the full audit
log, all in one SQLite file — persists in the `data` named volume across
container restarts (verified: connect a vault, restart the container, the
connection and audit trail are still there).

To build the image directly instead of via compose (must be run from the
**repo root**, since it needs the workspace's `package.json` files to
resolve `pnpm-lock.yaml`):

```bash
docker build -f apps/control-plane/Dockerfile -t secrefs-control-plane .
docker run -p 8787:8787 \
  -e SECREFS_CP_CIPHER_KEY=... \
  -e SECREFS_CP_DB_PATH=/data/control-plane.sqlite3 \
  -v secrefs-cp-data:/data \
  secrefs-control-plane
```

**Before pointing this at anything real, understand what self-hosting it
does *not* change** — it's the same v1 scaffold either way, all of "What
this is, honestly" below still applies in full. Self-hosting moves *where*
the container runs; it doesn't add KMS custody, real auth, or migrations.
Specifically, as the operator, you now own:

- **The cipher key's lifecycle.** `SECREFS_CP_CIPHER_KEY` is the only
  thing standing between the SQLite file and every connected org's vault
  credentials. Nothing here rotates it, backs it up, or recovers it if
  lost — losing the key makes every stored `VaultConnection` permanently
  undecryptable; losing the key *and* having it leak is worse. Generate it
  with a real secret manager, not a shell one-liner kept in your own
  `.env`.
- **The SQLite file's backup/durability story.** One file holds every
  org's encrypted connections, RBAC config, and audit log. The named
  volume survives a container restart (verified above) but is only as
  durable as wherever Docker's volume actually lives - back it up like
  you would any production database, because it is one.
- **TLS and network exposure.** The container serves plain HTTP on
  `:8787`. Put a real TLS-terminating proxy in front before this is
  reachable from anywhere you wouldn't trust with the requests it
  authorizes.
- **The `/healthz` endpoint** is wired into `docker-compose.yml`'s
  healthcheck already - point your own orchestrator's liveness probe at
  it too.

## API surface (v1)

| Route | What |
|---|---|
| `POST /v1/organizations` | Create an org |
| `POST /v1/service-identities` | Create a machine principal; response includes the bootstrap token **once** |
| `POST /v1/connections` | Connect a vault — `provider: "aws"` + `credential: { roleArn, region, externalId? }`, or `provider: "bitwarden"` + `credential: { accessToken, organizationId? }` |
| `POST /v1/roles` | Create a role |
| `POST /v1/roles/:roleId/bindings` | Bind a service identity to a role |
| `POST /v1/roles/:roleId/grants` | Grant a role access to a connection, scoped to a `pathPattern` (see `src/rbac/match.ts`) |
| `POST /v1/credentials/mint` | `Authorization: Bearer <bootstrap token>` + `{ alias, path }` → a resolved credential (freshly scoped for AWS, distributed as-is for Bitwarden — see above), or a `403` with why not |
| `GET /v1/audit` | This org's `AuthorizationEvent` log |

## Tests

```bash
pnpm --filter @secrefs/control-plane test
```

`test/app.e2e.test.ts` drives the full flow above through the real Fastify
app (in-memory SQLite, a mocked STS client) — connect → grant → mint →
deny → audit — and asserts the audit log never contains a secret value or
minted credential.
