import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Child processes, not worker threads. better-sqlite3 is a native
    // N-API addon and is not safe to use across worker threads - the
    // default `threads` pool crashed it on Node 24 with
    // "Assertion failed: (env) != nullptr" followed by
    // "Worker exited unexpectedly". It happened to survive on 20 and 22,
    // which is luck rather than correctness, so this is the right pool
    // regardless of which versions currently pass.
    pool: "forks",
  },
});
