# SecRefs

[![CI](https://github.com/secrefs/secrefs/actions/workflows/ci.yml/badge.svg)](https://github.com/secrefs/secrefs/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@secrefs/node?label=%40secrefs%2Fnode)](https://www.npmjs.com/package/@secrefs/node)
[![PyPI](https://img.shields.io/pypi/v/secrefs?label=secrefs)](https://pypi.org/project/secrefs/)
[![License](https://img.shields.io/badge/license-MIT%20%2F%20BUSL--1.1-blue)](LICENSING.md)

Put a reference in your config instead of a secret.

```diff
- DB_PASSWORD=correcthorsebatterystaple
+ DB_PASSWORD=sec://aws/prod/db#password
```

The second line is safe to commit. SecRefs resolves it from **your** vault, in
memory, at the moment it's used.

**Documentation: [secrefs.com](https://secrefs.com) · [docs](docs-site/)**

---

## What this is, and what it is not

SecRefs is a **reference engine**, not a vault. It never stores a secret and
never becomes a system of record. Your AWS Secrets Manager, Bitwarden, or
HashiCorp Vault instance stays the only place the value lives; SecRefs knows how
to read from it and gives you a stable name for a value that's free to change.

```
sec://<provider-alias>/<path>[#<json-field>]
```

**Non-goals**, stated so you can rule it out quickly:

- It is not a secret store. There is no "SecRefs vault" and there will not be.
- It does not encrypt anything at rest on your behalf. Your vault already does.
- It does not replace IAM. A reference is resolved with credentials you already
  have; SecRefs cannot grant access your identity doesn't already carry.

## Threat model

What a reference in your config buys you, stated precisely:

| | |
|---|---|
| **Prevents** | Plaintext in Git, in `.env` on N laptops, in CI logs, in shell history, in a Slack paste |
| **Prevents** | A consumer holding a value it can't be told to refresh |
| **Does not prevent** | Anything an attacker with your live credentials can do — a reference resolves for whoever can already authenticate |
| **Does not prevent** | Reading the value out of a compromised process's memory after resolution |

The security property is **narrower than "your secrets are safe"** and worth
being precise about: SecRefs shrinks the number of places a plaintext secret
exists from *many, indefinitely* to *one process, for the duration of one use*.

<sub>A future opt-in [proxy mode](docs/proxy-mode-design.md) would let SecRefs
resolve on a third party's behalf. It is specified and deliberately unbuilt; the
spec is explicit that it changes this model, and §6 covers the payload
encryption that would ship with it.</sub>

## Install

```bash
npm install @secrefs/node     # or: pnpm add @secrefs/node
pip  install secrefs
```

## Quickstart

No vault required — the `local` provider is a gitignored JSON file, so you can
see the mechanism work before wiring anything up.

```bash
cat > .secrefs.local.json <<'EOF'
{ "mock-db": { "password": "hunter2" } }
EOF

echo 'DB_PASSWORD=sec://local/mock-db#password' >> .env

npx secrefs run -- node server.js
```

`server.js` reads `process.env.DB_PASSWORD === "hunter2"`. The `sec://`
reference never leaves `.env`, and the resolved value is never written back to
it.

Point it at a real vault by changing the provider segment. Nothing else about
your application changes.

## Two ways to expand, and when each is wrong

A `sec://` reference is a **stable name for a value that changes**. Which entry
point you use decides whether that actually holds.

**At use.** Every call re-fetches, so rotating the value at the source reaches a
running consumer with no redeploy:

```ts
import { secRefs } from "@secrefs/node";

async function callVendorApi() {
  const key = await secRefs.expandString("sec://aws-prod/hackerone#api_key");
  return fetch(url, { headers: { authorization: `Bearer ${key}` } });
}
```

**At load** (`secrefs run`, or `init()`). Expands once at startup and bakes
plain strings into the environment. Right for short-lived processes like a CI
job — but an environment variable is a static string, so **a long-running
process keeps the pre-rotation value until it restarts**.

The honest cost of use-time resolution: it couples every use to your vault being
reachable and your credentials being valid *right now*. Load-time resolution
reads once and then survives anything. `cacheTtlMs` and `staleGraceMs` let you
tune that tradeoff — see
[load time vs use time](docs-site/guides/load-time-vs-use-time.mdx).

## Providers

| Alias | Backend | Ambient auth |
|---|---|---|
| `aws` | AWS Secrets Manager | Default credential chain / IAM role |
| `vault` | HashiCorp Vault (KV v1 & v2) | `VAULT_ADDR`, `VAULT_TOKEN` |
| `bitwarden` | Bitwarden Secrets Manager | `BWS_ACCESS_TOKEN`, `BWS_ORGANIZATION_ID` |
| `local` | Gitignored `.secrefs.local.json` | none — development only |

No provider ever needs a static credential in SecRefs' own configuration. The
provider segment is an **alias**, not a fixed type, so multiple accounts get
their own names — `sec://aws-prod/…` and `sec://aws-staging/…` are two
independently-authenticated connections.

`aws` and `bitwarden` can also source credentials from a running
[control plane](apps/control-plane) instead of the ambient environment:
RBAC-authorized, per-request for AWS, audited either way.

## Errors tell you whose problem it is

Failures are classified, because "your credentials expired" and "that secret
doesn't exist" have different fixes. An expired SSO session reports **once**,
with the command that fixes it — not once per reference:

```
secrefs: could not authenticate to a secret provider.
Cannot authenticate to provider "aws".
  [aws] cannot authenticate: Could not load credentials from any providers
  Check credentials for AWS profile "acme-prod" - if it uses SSO,
  run: aws sso login --profile acme-prod
  Not resolved: DB_PASSWORD, STRIPE_KEY, GITHUB_TOKEN
```

`AccessDenied` is deliberately *not* classified as an auth failure — the
credentials worked and a policy refused one secret. See
[troubleshooting](docs-site/guides/troubleshooting.mdx).

## Repository layout

| Path | What it is | License |
|---|---|---|
| `packages/node` | TypeScript engine + `secrefs` CLI → [`@secrefs/node`](https://www.npmjs.com/package/@secrefs/node) | MIT |
| `packages/python` | Python SDK + `secrefs-py` CLI, API parity → [`secrefs`](https://pypi.org/project/secrefs/) | MIT |
| `packages/npm-alias` | `npm install secrefs` alias for the scoped package | MIT |
| `apps/web` | secrefs.com + in-browser sandbox (S3 + CloudFront, CDK) | MIT |
| `apps/control-plane` | Org vault connections, RBAC, scoped credential minting | BUSL-1.1 |
| `apps/control-plane-admin` | Admin console, works against hosted or self-hosted | BUSL-1.1 |
| `docs-site` | Mintlify user documentation | MIT |

**The client libraries are MIT, permanently and unconditionally.** The control
plane is source-available under BUSL-1.1 — free for personal and non-production
use, converting to Apache 2.0 on 2030-09-01. See [LICENSING.md](LICENSING.md)
for why, in short: it handles credentials, so its claims should be checkable by
the teams being asked to trust them.

## Testing

```bash
pnpm install && pnpm build && pnpm test
```

**355 tests** across five suites, all green in CI on every push:

| Suite | Tests | Notes |
|---|---|---|
| `packages/node` | 103 | Parser, resolver, providers, error classification, cache semantics |
| `apps/control-plane` | 117 | Includes end-to-end RBAC, OIDC, and KMS envelope paths |
| `packages/python` | 97 | Plus `mypy` |
| `apps/web` | 24 | The live sandbox, driven through a real DOM |
| `apps/control-plane-admin` | 14 | Session expiry handling |

CI runs the control plane against **both** SQLite and a real PostgreSQL 16
service, because the dual-backend driver's whole point is untested if only one
is exercised — a suite that skips itself passes by not running.

## Security

Do not open a public issue for a vulnerability. Email **hello@secrefs.com**.

Two properties the test suite asserts and we intend to keep asserting:

- **Audit records hold decisions, never values.** No secret material reaches the
  `AuthorizationEvent` table, a log line, or an error message.
- **`check` never returns plaintext.** It validates every reference and reports
  ok/failure only, so it is safe to run in CI.

## Design documents

Architecture decisions, written before the code and kept honest about
tradeoffs:

- [`docs/control-plane-design.md`](docs/control-plane-design.md) — trust model, RBAC, credential minting
- [`docs/proxy-mode-design.md`](docs/proxy-mode-design.md) — third-party pass-through, and the security properties it costs
- [`docs/deployment-runbook.md`](docs/deployment-runbook.md) — getting it online, including the sharp edges
