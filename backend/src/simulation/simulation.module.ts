import { Module } from "@nestjs/common";

import { SimulationService } from "./simulation.service.js";
import { ForecastService } from "./forecast.service.js";
import { HistoryService } from "./history.service.js";
import { SummaryService } from "./summary.service.js";
import { OracleService } from "./oracle.service.js";
import { ConfigSyncService } from "../config/config-sync.service.js";
import { StorageModule } from "../storage/storage.module.js";

@Module({
  imports: [StorageModule],
  providers: [SimulationService, ForecastService, HistoryService, SummaryService, OracleService, ConfigSyncService],
  exports: [SimulationService, ForecastService, HistoryService, SummaryService, OracleService, ConfigSyncService],
})
export class SimulationModule {}
