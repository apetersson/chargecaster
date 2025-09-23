import { Module } from "@nestjs/common";

import { SimulationService } from "./simulation.service";
import { ForecastService } from "./forecast.service";
import { HistoryService } from "./history.service";
import { SummaryService } from "./summary.service";
import { OracleService } from "./oracle.service";
import { ConfigSyncService } from "../config/config-sync.service";
import { FroniusService } from "../fronius/fronius.service";
import { StorageModule } from "../storage/storage.module";

@Module({
  imports: [StorageModule],
  providers: [SimulationService, ForecastService, HistoryService, SummaryService, OracleService, ConfigSyncService, FroniusService],
  exports: [SimulationService, ForecastService, HistoryService, SummaryService, OracleService, ConfigSyncService, FroniusService],
})
export class SimulationModule {
}
