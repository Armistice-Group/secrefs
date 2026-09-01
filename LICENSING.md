# Licensing

This repository is dual-licensed. Which license applies depends on which
directory the code lives in, and every licensed directory carries its own
`LICENSE` file — that file is authoritative for its subtree.

| Path | License | What it is |
|---|---|---|
| `packages/node` | **MIT** | `@secrefs/node` — the Node.js client library and CLI |
| `packages/python` | **MIT** | `secrefs` — the Python client library and CLI |
| `apps/web` | **MIT** | The secrefs.com marketing site and sandbox |
| `apps/control-plane` | **BUSL-1.1** | The control plane API |
| `apps/control-plane-admin` | **BUSL-1.1** | The admin console |
| everything else | **MIT** | Docs, tooling, CI config |

## Why the split

**The libraries are MIT, permanently and unconditionally.** They are what you
put in your own applications, and nobody should have to think about licensing
to import a client library. Use them commercially, embed them in a closed
product, fork them — no permission needed, no strings.

**The control plane is source-available under the Business Source License.**
You can read all of it, audit it, modify it, and run it. The one thing you
cannot do without a commercial license is operate it as a business:

- **Free, no license needed** — running the control plane for yourself, your
  personal projects, or a non-profit hobby community. Also any non-production
  use: evaluating it, developing against it, running it in CI.
- **Requires a commercial license** — operating it in production in support of
  a commercial product or business, or offering it to others as a hosted
  service.

Contact **hello@secrefs.com** for a commercial license.

## The Change Date

Each BUSL-licensed version converts to **Apache 2.0 on 2030-09-01**, or four
years after that version was first published, whichever comes first. The
restriction above is time-limited by construction — every release eventually
becomes fully open source, and that is a term of the license, not a promise.

## Why source-available rather than closed

SecRefs handles credentials. Asking a security team to route their secrets
through a binary they cannot inspect is a bad trade, and one most of them will
refuse. The control plane is readable so that its claims are checkable — that
the authorization path is what the docs say it is, that audit records hold
decisions and never values. That auditability is worth more than the secrecy
would be.
