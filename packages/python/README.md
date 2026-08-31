# secrefs (Python)

Python SDK/CLI parity with `@secrefs/node`. See the repo root README for the
full `sec://` reference spec and provider list.

## Install

```bash
pip install secrefs
# Bitwarden Secrets Manager support is an extra - see "Providers" below:
pip install 'secrefs[bitwarden]'
# or, in this monorepo:
poetry install
```

## Library usage

```python
import asyncio
import os
from secrefs import sec_refs

async def main():
    await sec_refs.init()  # expands sec:// values in os.environ, in place
    print(os.environ["DB_PASSWORD"])

asyncio.run(main())
```

## Two ways to expand, and when each is wrong

A `sec://` reference is a **stable name for a value that changes**. Which of
these you use decides whether that actually holds:

**At use (recommended).** Expand where the secret is consumed. Every call
re-fetches, so rotating the value at the source reaches this consumer with
no redeploy:

```python
async def call_vendor_api():
    key = await sec_refs.expand_string("sec://aws/hackerone#api_key")
    ...
```

**At load (`secrefs-py run`).** Expands once at startup and bakes plain
strings into the child's environment. Convenient, and the right choice for
short-lived processes like a CI job — but an environment variable is a
static string, so **a long-running process keeps the pre-rotation value
until it restarts**.

Network-backed providers re-fetch on every expansion by default. Concurrent
expansions of the same reference still share one request, and `cache_ttl_ms`
trades a bounded window of staleness for fewer round trips if you need it:

```python
AWSSecretsManagerProvider(cache_ttl_ms=30_000)  # rotation lands within 30s
```

`LocalProvider` re-reads its JSON file per fetch for the same reason, so
editing `.secrefs.local.json` mid-session takes effect; `cache_file=True`
restores the old behavior.

## Providers

| Alias | Backend | Ambient auth |
|---|---|---|
| `aws` | AWS Secrets Manager | boto3's default credential chain |
| `vault` | HashiCorp Vault (KV v1/v2) | `VAULT_ADDR` / `VAULT_TOKEN` |
| `bitwarden` | Bitwarden Secrets Manager | `BWS_ACCESS_TOKEN` / `BWS_ORGANIZATION_ID` |
| `local` | gitignored JSON file | n/a - development only |

`bitwarden` needs the `secrefs[bitwarden]` extra: Bitwarden secrets are
end-to-end encrypted, so only Bitwarden's own SDK can decrypt them, and it
ships as prebuilt native wheels for a fixed set of platforms. It's an extra
rather than a hard dependency so a platform it doesn't build for can still
install SecRefs.

## Control-plane-sourced credentials

`AWSSecretsManagerProvider` and `BitwardenProvider` can source credentials
per request from a running control plane instead of the ambient environment
(see `docs/control-plane-design.md`), so each fetch is authenticated,
RBAC-checked and audited on the control plane's side:

```python
from secrefs import AWSSecretsManagerProvider, ControlPlaneCredentialSource

AWSSecretsManagerProvider(
    control_plane=ControlPlaneCredentialSource(
        base_url=os.environ["SECREFS_CONTROL_PLANE_URL"],
        token=os.environ["SECREFS_CONTROL_PLANE_TOKEN"],
        alias="aws-prod",
    )
)
```

## CLI usage

```bash
secrefs-py run -- python app.py
secrefs-py check
```
