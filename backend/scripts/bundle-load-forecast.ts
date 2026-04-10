import { cpSync, existsSync, rmSync } from "node:fs";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import YAML from "yaml";

import { ConfigFileService } from "../src/config/config-file.service";
import { parseConfigDocument } from "../src/config/schemas";
import { LoadForecastArtifactService } from "../src/forecasting/load-forecast-artifact.service";

function resolveVersionArg(args: string[]): string | null {
  return args.find((arg) => arg.trim().length > 0 && arg !== "--") ?? null;
}

function main(): void {
  const version = resolveVersionArg(process.argv.slice(2));
  if (!version) {
    throw new Error("Usage: tsx scripts/bundle-load-forecast.ts <version-dir-name>");
  }

  const configService = new ConfigFileService();
  const configPath = process.env.CHARGECASTER_CONFIG?.trim() || configService.resolvePath();
  const config = parseConfigDocument(YAML.parse(readFileSync(configPath, "utf-8")));
  const artifactService = new LoadForecastArtifactService();
  const versionDir = join(artifactService.ensureBaseDir(config), version);
  if (!existsSync(versionDir)) {
    throw new Error(`Load-forecast artifact directory not found: ${versionDir}`);
  }

  const inspection = artifactService.inspectVersionArtifact(config, versionDir);
  if (!inspection.artifact) {
    throw new Error(`Load-forecast artifact ${versionDir} is not bundleable (${inspection.reason})`);
  }

  const bundledDir = join(process.cwd(), "assets", "load-forecast", "current");
  rmSync(bundledDir, { recursive: true, force: true });
  cpSync(versionDir, bundledDir, { recursive: true });
  console.log(`Bundled load-forecast artifact ${inspection.artifact.manifest.model_version} into ${bundledDir}`);
}

main();
