# SecRefs

[![CI](https://github.com/Armistice-Group/secrefs/actions/workflows/ci.yml/badge.svg)](https://github.com/Armistice-Group/secrefs/actions/workflows/ci.yml)

**Bring Your Own Vault.** SecRefs decouples secret storage from applications by
expanding declarative `sec://` URI references directly in memory, at runtime.
No plaintext secret is ever written to disk or sent to a third-party SaaS vault.

```
sec://<provider-alias>/<secret-path-or-id>[#<json-field>]

sec://aws/prod/db#password
sec://vault/secret/data/stripe#key
sec://local/mock-db#password
```

## Monorepo layout

| Path | What it is |
|---|---|
| `packages/node` | Node.js/TypeScript engine + `secrefs` CLI (published as `@secrefs/node`) |
| `packages/python` | Python SDK + `secrefs-py` CLI, API parity with the Node engine |
| `apps/web` | secrefs.com marketing site + interactive in-browser sandbox |
| `apps/web/infra` | AWS CDK stack (Route 53 + ACM + S3 + CloudFront) that hosts the site |
| `apps/control-plane` | Org vault connections + RBAC + scoped credential minting (AWS + Bitwarden). See [`docs/control-plane-design.md`](docs/control-plane-design.md). |
| `apps/control-plane-admin` | Admin console for the control plane — works against a hosted or self-hosted instance |

## Quickstart (Node)

```bash
pnpm add @secrefs/node

cat > .secrefs.local.json <<'EOF'
{ "mock-db": { "password": "hunter2" } }
EOF

echo 'DB_PASSWORD=sec://local/mock-db#password' >> .env

npx secrefs run -- node server.js
```

`server.js` sees `process.env.DB_PASSWORD === "hunter2"` — the literal
`sec://` reference never touches disk, and the resolved value never gets
written back to `.env`.

## Quickstart (Python)

```bash
pip install secrefs

python -c "
import asyncio, os
from secrefs import sec_refs

async def main():
    await sec_refs.init()
    print(os.environ['DB_PASSWORD'])

asyncio.run(main())
"
```

## Two ways to expand, and when each is wrong

A `sec://` reference is a **stable name for a value that changes**. Which
of these you use decides whether that actually holds:

**At use (recommended).** Expand where the secret is consumed. Every call
re-fetches, so rotating the value at the source reaches this consumer
with no redeploy:

```ts
import { secRefs } from "@secrefs/node";

async function callVendorApi() {
  const key = await secRefs.expandString("sec://aws-prod/hackerone#api_key");
  return fetch(url, { headers: { authorization: `Bearer ${key}` } });
}
```

**At load (`secrefs run`).** Expands once at startup and bakes plain
strings into the child's environment. Convenient, and the right choice
for short-lived processes like a CI job — but an environment variable is
a static string, so **a long-running process keeps the pre-rotation value
until it restarts**. Don't use it for the thing you intend to rotate
underneath a running service.

Network-backed providers re-fetch on every expansion by default.
Concurrent expansions of the same reference still share one request, and
`cacheTtlMs` trades a bounded window of staleness for fewer round trips
if you need it:

```ts
new AwsSecretsManagerProvider({ cacheTtlMs: 30_000 }); // rotation lands within 30s
```

## Providers

| Alias | Backend | Ambient auth |
|---|---|---|
| `aws` | AWS Secrets Manager | Default credential provider chain / IAM role |
| `vault` | HashiCorp Vault (KV v1 & v2) | `VAULT_ADDR`, `VAULT_TOKEN` |
| `bitwarden` | Bitwarden Secrets Manager | `BWS_ACCESS_TOKEN`, `BWS_ORGANIZATION_ID` (only needed to address a secret by name instead of its UUID) |
| `local` | Gitignored `.secrefs.local.json` | none — local dev only |

The `aws` and `bitwarden` providers can also source their credentials
from a running [control plane](apps/control-plane) instead of ambient
env vars — RBAC-authorized, per-request for AWS, audited either way:

```ts
import { AwsSecretsManagerProvider, SecRefs } from "@secrefs/node";

const secRefs = new SecRefs({
  providers: {
    "aws-prod": new AwsSecretsManagerProvider({
      region: "us-east-1",
      controlPlane: {
        baseUrl: process.env.SECREFS_CONTROL_PLANE_URL!,
        token: process.env.SECREFS_CONTROL_PLANE_TOKEN!, // bootstrap token or a verified OIDC token
        alias: "aws-prod", // must match the VaultConnection's alias on the control plane
      },
    }),
  },
});
```

## Development

```bash
pnpm install
pnpm build
pnpm test
```

See each package's own README/`pyproject.toml` for package-specific commands.
# secrefs
