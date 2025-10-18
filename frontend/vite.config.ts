import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const domainEntry = resolve(dirname(fileURLToPath(import.meta.url)), "../packages/domain/src/index.ts");

export default defineConfig(() => ({
  plugins: [react()],
  // Use Node's default symlink resolution for workspace deps during build
  // to ensure package "exports" and entrypoints resolve correctly.
  resolve: {
    preserveSymlinks: false,
    alias: {
      "@chargecaster/domain": domainEntry,
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
}));
