import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

function resolveCatBoostLibraryDir(): string | null {
  const packageRoots = [
    join(process.cwd(), "node_modules", ".pnpm"),
    join(process.cwd(), "backend", "node_modules", ".pnpm"),
  ];

  for (const packageRoot of packageRoots) {
    if (!existsSync(packageRoot)) {
      continue;
    }
    const match = readdirSync(packageRoot)
      .filter((entry) => entry.startsWith("catboost@"))
      .sort()
      .at(-1);
    if (!match) {
      continue;
    }
    const libraryDir = join(
      packageRoot,
      match,
      "node_modules",
      "catboost",
      "build",
      "catboost",
      "libs",
      "model_interface",
    );
    if (existsSync(join(libraryDir, "libcatboostmodel.so"))) {
      return libraryDir;
    }
  }

  return null;
}

export function ensureCatBoostRuntimeLibraryPath(): void {
  const libraryDir = resolveCatBoostLibraryDir();
  if (!libraryDir) {
    return;
  }

  const current = process.env.LD_LIBRARY_PATH
    ?.split(":")
    .filter((entry) => entry.length > 0) ?? [];
  if (current.includes(libraryDir)) {
    return;
  }
  process.env.LD_LIBRARY_PATH = [libraryDir, ...current].join(":");
}
