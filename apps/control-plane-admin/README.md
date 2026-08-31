# @secrefs/control-plane-admin

The admin console for a [SecRefs control plane](../control-plane) — connect
vaults, define roles and grants, issue service identities, and read the
audit log.

Pure client-side app, statically exported. It talks to a control plane
over HTTP and holds no state of its own, which is what lets the same build
serve both deployment shapes:

- **SecRefs-hosted / any WorkOS-configured control plane** — the console
  requires an admin session and sends it as a bearer token.
- **Self-hosted with no admin auth** — the control plane has no WorkOS
  configured, so its management endpoints are open. The console sends no
  token and shows a standing warning banner saying so.

Which one applies is discovered at runtime from `GET /v1/config`, not
baked in at build time, so one artifact works against either.

## Run it

```bash
pnpm --filter @secrefs/control-plane-admin dev   # http://localhost:3001
```

The control plane must allow this origin, or every request the console
makes is blocked by the browser:

```bash
SECREFS_CP_CORS_ORIGINS=http://localhost:3001 node dist/server.js
```

| Env var | Default | Purpose |
|---|---|---|
| `NEXT_PUBLIC_CONTROL_PLANE_URL` | `http://localhost:8787` | Control plane origin. Baked in at build time — a deployed console is built against the control plane it serves. |

## Build and serve

```bash
pnpm --filter @secrefs/control-plane-admin build
# → out/  — plain static files, serve from anywhere
```

Because it's a static export, self-hosting is "serve this directory" — no
second Node process next to the control plane.

## Auth status

`src/lib/auth.ts` is the seam for WorkOS AuthKit. **The redirect sign-in
flow isn't wired yet** — `isRedirectSignInAvailable()` returns `false` and
says so rather than pretending. Against a WorkOS-configured control plane
the console reads a session token from `localStorage`, so it's operable
(and testable) before the redirect flow lands. Wiring AuthKit means
implementing sign-in in that one file; no screen changes.

## Notes on shape

- **Org selection is a query param** (`?org=<id>`), not a route segment.
  Static export can't pre-render `/orgs/[orgId]` for orgs that don't exist
  at build time.
- **Wire types are copied**, not imported from the control plane package
  (`src/lib/types.ts`). The console is deployable against any control
  plane instance, including one running a different version — a
  compile-time coupling would imply a guarantee that doesn't hold.
- **Mono type marks anything machine-addressable**: aliases, paths,
  patterns, ids, tokens. That's how you tell at a glance what you can
  paste into a `sec://` reference.
