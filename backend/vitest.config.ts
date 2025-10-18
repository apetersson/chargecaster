import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const domainEntry = resolve(dirname(fileURLToPath(import.meta.url)), "../packages/domain/src/index.ts");

export default defineConfig({
  resolve: {
    preserveSymlinks: true,
    alias: {
      "@chargecaster/domain": domainEntry,
    },
  },
  test: {
    pool: "forks",
    globals: true,
  },
});
