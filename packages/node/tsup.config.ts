import { defineConfig } from "tsup";

// NOTE: tsup builds every entry in this array concurrently, not
// sequentially - `clean: true` on any one of them races the others'
// output (a clean that finishes after a sibling has already written its
// files deletes them, with nothing left to rewrite them). So `dist/` is
// wiped exactly once up front, via the package's `build` script
// (`rimraf dist && tsup`), and every entry here sets `clean: false`.
export default defineConfig([
  {
    entry: { index: "src/index.ts" },
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: true,
    clean: false,
    target: "node18",
    splitting: false,
    shims: true,
  },
  {
    // Pure, dependency-free parsing logic with zero Node built-ins or
    // provider SDKs - safe to import from a browser bundle (e.g. the
    // web app's Sandbox component) without pulling in fs/net/aws-sdk.
    entry: { parser: "src/parser.ts" },
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: true,
    clean: false,
    target: "es2020",
    platform: "neutral",
    splitting: false,
  },
  {
    // bin/secrefs.ts already starts with its own "#!/usr/bin/env node" -
    // esbuild auto-preserves a leading shebang from the entry file, so no
    // extra `banner` is needed here (and adding one would duplicate it).
    entry: { secrefs: "bin/secrefs.ts" },
    format: ["cjs"],
    sourcemap: true,
    target: "node18",
    splitting: false,
    clean: false,
  },
]);
