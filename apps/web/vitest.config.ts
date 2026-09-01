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
    },
  },
});
