# SecRefs

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
| `apps/control-plane` | Org vault connections + RBAC + scoped credential minting (v1: AWS only). See [`docs/control-plane-design.md`](docs/control-plane-design.md). |

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

## Providers

| Alias | Backend | Ambient auth |
|---|---|---|
| `aws` | AWS Secrets Manager | Default credential provider chain / IAM role |
| `vault` | HashiCorp Vault (KV v1 & v2) | `VAULT_ADDR`, `VAULT_TOKEN` |
| `local` | Gitignored `.secrefs.local.json` | none — local dev only |

## Development

```bash
pnpm install
pnpm build
pnpm test
```

See each package's own README/`pyproject.toml` for package-specific commands.
# secrefs
