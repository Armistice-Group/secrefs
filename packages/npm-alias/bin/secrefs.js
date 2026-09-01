#!/usr/bin/env node
// Forwards to the real CLI so `npx secrefs run -- ...` works identically
// whether you installed `secrefs` or `@secrefs/node`.
//
// The CLI entrypoint is resolved via @secrefs/node's package.json rather
// than imported by path: its `exports` map deliberately exposes only ".",
// "./parser" and "./package.json", so a direct import of dist/secrefs.cjs
// fails with ERR_PACKAGE_PATH_NOT_EXPORTED. package.json is exported, so
// resolving that and walking to the declared `bin` gets there without
// depending on the internal layout.
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const require = createRequire(import.meta.url);
const manifestPath = require.resolve("@secrefs/node/package.json");
const { bin } = require(manifestPath);
const cliRelative = typeof bin === "string" ? bin : bin.secrefs;

await import(pathToFileURL(resolve(dirname(manifestPath), cliRelative)).href);
