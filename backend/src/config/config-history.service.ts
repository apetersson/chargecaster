import { Inject, Injectable, Logger } from "@nestjs/common";

import { StorageService } from "../storage/storage.service";
import type { ConfigDocument } from "./schemas";
import { SimulationConfigFactory } from "./simulation-config.factory";

@Injectable()
export class ConfigHistoryService {
  private readonly logger = new Logger(ConfigHistoryService.name);

  constructor(
    @Inject(StorageService) private readonly storage: StorageService,
    @Inject(SimulationConfigFactory) private readonly configFactory: SimulationConfigFactory,
  ) {}

  recordStartupConfig(config: ConfigDocument, observedAt = new Date().toISOString()): {
    fingerprint: string;
    inserted: boolean;
  } {
    const fingerprint = this.storage.buildConfigFingerprint(config);
    const latest = this.storage.getLatestConfigSnapshot();
    if (latest?.fingerprint === fingerprint) {
      this.logger.log(`Startup config unchanged (${fingerprint.slice(0, 8)}); keeping existing snapshot.`);
      return {fingerprint, inserted: false};
    }

    this.storage.appendConfigSnapshot({
      fingerprint,
      observedAt,
      payload: config,
      simulationConfig: this.configFactory.create(config),
    });
    this.logger.log(`Recorded startup config snapshot ${fingerprint.slice(0, 8)}.`);
    return {fingerprint, inserted: true};
  }
}
