import { Module } from "@nestjs/common";

import { SimulationService } from "./simulation.service.ts";
import { ForecastService } from "./forecast.service.ts";
import { HistoryService } from "./history.service.ts";
import { SummaryService } from "./summary.service.ts";
import { OracleService } from "./oracle.service.ts";
import { ConfigSyncService } from "../config/config-sync.service.ts";
import { StorageModule } from "../storage/storage.module.ts";

@Module({
  imports: [StorageModule],
  providers: [SimulationService, ForecastService, HistoryService, SummaryService, OracleService, ConfigSyncService],
  exports: [SimulationService, ForecastService, HistoryService, SummaryService, OracleService, ConfigSyncService],
})
export class SimulationModule {}
