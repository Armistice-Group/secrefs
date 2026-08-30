import { defineConfig } from "tsup";

export default defineConfig({
  entry: { server: "src/server.ts" },
  format: ["esm"],
  sourcemap: true,
  target: "node18",
  splitting: false,
  clean: true,
});
