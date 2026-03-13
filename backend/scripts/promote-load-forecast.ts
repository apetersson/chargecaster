import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { join } from "node:path";

import YAML from "yaml";

import { ConfigFileService } from "../src/config/config-file.service";
import { parseConfigDocument } from "../src/config/schemas";
import { LoadForecastArtifactService } from "../src/forecasting/load-forecast-artifact.service";

function main(): void {
  const version = process.argv[2];
  if (!version) {
    throw new Error("Usage: tsx scripts/promote-load-forecast.ts <version-dir-name>");
  }
  const configService = new ConfigFileService();
  const configPath = process.env.CHARGECASTER_CONFIG?.trim() || configService.resolvePath();
  const config = parseConfigDocument(YAML.parse(readFileSync(configPath, "utf-8")));
  const artifactService = new LoadForecastArtifactService();
  const baseDir = artifactService.ensureBaseDir(config);
  const versionDir = join(baseDir, version);
  if (!existsSync(versionDir)) {
    throw new Error(`Load-forecast artifact directory not found: ${versionDir}`);
  }
  artifactService.promoteVersion(config, versionDir);
  artifactService.writePromotionMarker(versionDir);
}

main();
