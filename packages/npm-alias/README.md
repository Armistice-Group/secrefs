# secrefs

**This package is an alias for [`@secrefs/node`](https://www.npmjs.com/package/@secrefs/node).**

It exists because `npm install secrefs` is what people naturally type, and
leaving that name unclaimed on a package that resolves credentials is an
invitation to a typosquatter. Rather than park an empty placeholder here, this
is a working alias: it depends on `@secrefs/node` and re-exports it wholesale,
CLI included.

Either of these gets you the same library:

```bash
npm install secrefs           # this package - re-exports the one below
npm install @secrefs/node     # the real package
```

**New code should depend on `@secrefs/node` directly.** This alias is
maintained for convenience and will track the same version, but the scoped
package is the canonical one and gets the documentation.

## What it actually does

```ts
// index.js, in its entirety
export * from "@secrefs/node";
```

The `secrefs` binary forwards to the real CLI, so `npx secrefs run -- node
server.js` behaves identically either way.

## What SecRefs is

Put a reference in your config instead of a secret:

```diff
- DB_PASSWORD=correcthorsebatterystaple
+ DB_PASSWORD=sec://aws/prod/db#password
```

The second line is safe to commit. SecRefs resolves it from your own vault —
AWS Secrets Manager, HashiCorp Vault, Bitwarden — in memory, at the moment it's
used. The reference is stable; the value underneath it is free to rotate.

Full documentation lives with the canonical package:
**[@secrefs/node](https://www.npmjs.com/package/@secrefs/node)** ·
[github.com/secrefs/secrefs](https://github.com/secrefs/secrefs) ·
[secrefs.com](https://secrefs.com)

## License

MIT.
