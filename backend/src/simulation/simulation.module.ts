import { Module } from "@nestjs/common";

import { SimulationService } from "./simulation.service.js";
import { ConfigSyncService } from "../config/config-sync.service.js";
import { StorageModule } from "../storage/storage.module.js";

@Module({
  imports: [StorageModule],
  providers: [SimulationService, ConfigSyncService],
  exports: [SimulationService, ConfigSyncService],
})
export class SimulationModule {}
