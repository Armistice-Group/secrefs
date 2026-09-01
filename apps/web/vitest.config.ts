import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    // The sandbox is a client component - it needs a DOM to render into.
    environment: "jsdom",
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    globals: true,
    setupFiles: ["./test/setup.ts"],
  },
  resolve: {
    alias: {
      // Mirrors the `@/*` path alias in tsconfig.json. Vitest does not read
      // tsconfig paths on its own, and without this the component import
      // fails to resolve.
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // The Sandbox imports the real `sec://` parser from @secrefs/node,
      // whose package exports point at dist/. On a clean checkout dist/
      // does not exist yet, so resolution fails and vitest collects zero
      // tests - which it reports as a pass-shaped "no tests" rather than a
      // hard error. Aliasing to source removes the dependency on build
      // order entirely, and tests the parser we actually edit.
      "@secrefs/node/parser": fileURLToPath(
        new URL("../../packages/node/src/parser.ts", import.meta.url),
      ),
    },
  },
});
