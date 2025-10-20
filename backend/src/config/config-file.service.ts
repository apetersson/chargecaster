import { constants as fsConstants, accessSync, readFileSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Injectable, Logger } from "@nestjs/common";
import YAML from "yaml";

import type { ConfigDocument } from "./schemas";
import { parseConfigDocument } from "./schemas";

const DEFAULT_CONFIG_FILE = "../config.local.yaml";

@Injectable()
export class ConfigFileService {
  private readonly logger = new Logger(ConfigFileService.name);

  resolvePath(): string {
    const override = process.env.CHARGECASTER_CONFIG;
    if (override && override.trim().length > 0) {
      return resolve(process.cwd(), override.trim());
    }
    return resolve(process.cwd(), DEFAULT_CONFIG_FILE);
  }

  async loadDocument(path: string): Promise<ConfigDocument> {
    this.logger.verbose(`Loading configuration from ${path}`);
    try {
      await access(path, fsConstants.R_OK);
    } catch (error) {
      const message = `Config file not accessible at ${path}: ${this.describeError(error)}`;
      this.logger.error(message);
      throw new Error(message);
    }

    const rawContent = await readFile(path, "utf-8");
    const parsed: unknown = YAML.parse(rawContent);
    if (!parsed || typeof parsed !== "object") {
      throw new Error("Config file is empty or invalid");
    }
    return parseConfigDocument(parsed);
  }

  loadDocumentSync(path: string): ConfigDocument {
    this.logger.verbose(`Loading configuration (sync) from ${path}`);
    try {
      accessSync(path, fsConstants.R_OK);
    } catch (error) {
      const message = `Config file not accessible at ${path}: ${this.describeError(error)}`;
      this.logger.error(message);
      throw new Error(message);
    }

    const rawContent = readFileSync(path, "utf-8");
    const parsed: unknown = YAML.parse(rawContent);
    if (!parsed || typeof parsed !== "object") {
      throw new Error("Config file is empty or invalid");
    }
    return parseConfigDocument(parsed);
  }

  private describeError(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    return String(error);
  }
}
