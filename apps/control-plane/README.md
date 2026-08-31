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

- ~~Credential custody is a single static key~~ **Fixed, but opt-in.**
  `KmsEnvelopeCipher` (`src/crypto/kmsCipher.ts`) implements the real
  per-credential envelope encryption design doc §4 specifies — a fresh
  AES-256 data key per `encrypt()` call via AWS KMS `GenerateDataKey`,
  wrapped under your own KMS key, org-bound via KMS `EncryptionContext`
  (decrypting with the wrong org fails at the KMS API itself). Set
  `SECREFS_CP_KMS_KEY_ID` to use it; the static-key `AesGcmCipher`
  (`src/crypto/cipher.ts`) is still there and still a legitimate choice
  for a self-hoster whose own infra's disk encryption is their trust
  boundary — see `src/crypto/selectCipher.ts` for exactly how the choice
  is made.
- ~~Auth is bootstrap-token only~~ **Fixed, additive.** Workload identity
  federation (docs §9) is real now — `src/auth/oidc.ts` verifies a CI
  job's own OIDC ID token against a pinned issuer + JWKS (never discovered
  from the token's own claims — see that file's docstring for why), and
  `src/auth/principal.ts` matches its `sub` claim against registered
  `oidc_bindings`. Presets for GitHub Actions and GitLab CI, plus a
  generic escape hatch for any other OIDC issuer — see the env vars
  below. Bootstrap tokens are still fully supported and remain the
  fallback for platforms with no OIDC issuer to federate against.
- ~~No database migrations~~ **Fixed.** `src/db/migrations/` is a real,
  ordered, transactional migration framework (`src/db/migrate.ts`) with a
  one-time compatibility shim (`adoptPreMigrationSchema` in
  `src/db/client.ts`) for anyone who already deployed the pre-migration
  scaffold — verified against a real on-disk file created the old way.
- ~~Secrets Manager ARNs are wildcard-suffixed~~ **Improved, not fully
  fixed.** The *first* mint for a given secret is still wildcard-scoped
  (unavoidable — AWS's random ARN suffix isn't knowable in advance), but
  it now also resolves the exact ARN via one `DescribeSecret` call and
  caches it, so every mint after that is scoped to the precise ARN, not
  the wildcard. See `src/providers/awsSts.ts`.

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
| `SECREFS_CP_CIPHER_KEY` | — | Local-dev/self-host cipher key, base64, must decode to exactly 32 bytes — see the generator command above. Required unless `SECREFS_CP_KMS_KEY_ID` is set. |
| `SECREFS_CP_KMS_KEY_ID` | — | AWS KMS key id/ARN/alias — set this instead of `SECREFS_CP_CIPHER_KEY` to use real KMS envelope encryption. Takes priority if both are set. |
| `SECREFS_CP_KMS_REGION` | ambient AWS region | Region for the KMS client, only relevant with `SECREFS_CP_KMS_KEY_ID` |
| `SECREFS_CP_OIDC_GITHUB_ACTIONS` | — | Set to `true` to trust GitHub Actions' own OIDC issuer |
| `SECREFS_CP_OIDC_GITLAB` | — | Set to `true` for gitlab.com, or a self-managed instance's base URL |
| `SECREFS_CP_TRUSTED_OIDC_ISSUERS` | — | JSON `{issuer, jwksUrl}[]` — the generic/configurable path for any other OIDC issuer |
| `SECREFS_CP_OIDC_AUDIENCE` | — | Required if any OIDC issuer above is configured — the `aud` claim every trusted token must carry |

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
| `POST /v1/service-identities/:id/oidc-bindings` | Trust a CI job's OIDC identity instead of (or alongside) a bootstrap token — `{ issuer, subjectPattern }`, `subjectPattern` matched against the token's `sub` claim with the same glob-lite rules as `Grant.path_pattern` |
| `POST /v1/connections` | Connect a vault — `provider: "aws"` + `credential: { roleArn, region, externalId? }`, or `provider: "bitwarden"` + `credential: { accessToken, organizationId? }` |
| `POST /v1/roles` | Create a role |
| `POST /v1/roles/:roleId/bindings` | Bind a service identity to a role |
| `POST /v1/roles/:roleId/grants` | Grant a role access to a connection, scoped to a `pathPattern` (see `src/rbac/match.ts`) |
| `POST /v1/credentials/mint` | `Authorization: Bearer <bootstrap token OR verified OIDC token>` + `{ alias, path }` → a resolved credential (freshly scoped for AWS, distributed as-is for Bitwarden — see above), or a `403` with why not |
| `GET /v1/audit` | This org's `AuthorizationEvent` log |

## Tests

```bash
pnpm --filter @secrefs/control-plane test
```

`test/app.e2e.test.ts` drives the full flow above through the real Fastify
app (in-memory SQLite, a mocked STS client) — connect → grant → mint →
deny → audit — and asserts the audit log never contains a secret value or
minted credential.
