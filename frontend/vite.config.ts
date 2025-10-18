import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ command }) => {
  const alias = command === "build"
    ? { "@chargecaster/domain": new URL("../packages/domain/dist", import.meta.url).pathname }
    : {};

  return {
    plugins: [react()],
    // Use Node's default symlink resolution for workspace deps during build
    // to ensure package "exports" and entrypoints resolve correctly.
    resolve: {
      preserveSymlinks: false,
      alias,
    },
    build: {
      outDir: "dist",
      emptyOutDir: true,
    },
  };
});
