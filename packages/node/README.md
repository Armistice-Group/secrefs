# @secrefs/node

Put a reference in your config instead of a secret.

```diff
- DB_PASSWORD=correcthorsebatterystaple
+ DB_PASSWORD=sec://aws/prod/db#password
```

The second line is safe to commit. SecRefs resolves it from your own vault, in
memory, at the moment it is used — the value never lands on disk, in shell
history, or in a CI log.

**Bring your own vault.** SecRefs is not a place to store secrets and never
holds a copy of one. Your AWS Secrets Manager, HashiCorp Vault, or Bitwarden
instance stays the single source of truth; this library just knows how to read
from it.

## Install

```bash
npm install @secrefs/node    # or: pnpm add @secrefs/node
```

## Use it

### Wrap your process

The CLI expands every `sec://` value in the environment and hands the real
values to your program:

```bash
npx secrefs run -- node server.js
# secrefs: resolved 2 secret reference(s): DB_PASSWORD, STRIPE_KEY
```

Your app reads `process.env.DB_PASSWORD` as it always did. Nothing else changes.

### Or call it directly

```ts
import { secRefs } from "@secrefs/node";

// Expand everything in process.env, once, at boot.
await secRefs.init();

// Or resolve a single reference at the point of use.
const key = await secRefs.expandString("sec://vault/secret/data/stripe#key");
```

### Check without resolving

`check()` validates every reference it can see and **never returns a plaintext
value** — safe to run in CI to catch a typo'd path before it pages someone.

```ts
const report = await secRefs.check();
```

## A stable name for a value that changes

`expandString()` re-fetches by default (`cacheTtlMs` is `0`), which means a
rotated secret reaches a long-running process without a restart or a redeploy:

```ts
const secRefs = new SecRefs();
const REF = "sec://aws/prod/db#password";

await secRefs.expandString(REF); // "live-verify-8c41f9d2"
// ... the secret is rotated in AWS, out of band ...
await secRefs.expandString(REF); // "ROTATED-3b7e01aa"  - same process, same reference
```

The reference is the stable thing; the value underneath it is free to move.
Set `cacheTtlMs` above zero to trade a bounded window of staleness for fewer
round trips — concurrent resolutions of the same reference are coalesced into
one fetch either way.

Note the difference between the two entry points: `init()` hydrates
`process.env` once at boot, so a rotation reaches it on the next restart.
`expandString()` is the use-time path, and it is the one that picks up a
rotation live.

## The reference format

```
sec://<provider>/<path>[#field]
```

| Part | Meaning |
|---|---|
| `provider` | Which vault to ask — `aws`, `vault`, `bitwarden`, `local` |
| `path` | The secret's identifier within that vault |
| `field` | Optional. Extracts one key from a JSON secret |

`sec://aws/prod/db#password` reads the `password` field out of the JSON stored
at `prod/db`, and returns only that field.

## Providers

| Provider | Reference | Authentication |
|---|---|---|
| AWS Secrets Manager | `sec://aws/...` | The standard AWS credential chain — env vars, shared config, or an instance/IRSA role |
| HashiCorp Vault | `sec://vault/...` | `VAULT_ADDR` / `VAULT_TOKEN` from the environment. KV v1 and v2 |
| Bitwarden | `sec://bitwarden/...` | A machine account access token |
| Local (dev only) | `sec://local/...` | A gitignored `.secrefs.local.json`, for teammates without vault access yet |

No provider ever needs a static credential in SecRefs' own configuration.

## Missing references fail loudly

Strict mode is the default: a reference that cannot be resolved throws rather
than silently yielding `undefined` and letting your app boot half-configured.
Pass `{ strict: false }` if you'd rather leave unresolvable references in place.

Every reference resolves concurrently, and one failure never blocks the others.

## License

MIT. See [LICENSE](./LICENSE).

The client libraries are MIT permanently and unconditionally — the SecRefs
control plane is licensed separately. See
[LICENSING.md](https://github.com/secrefs/secrefs/blob/main/LICENSING.md).
