import { Module } from "@nestjs/common";

import { SimulationService } from "./simulation.service";
import { ForecastService } from "./forecast.service";
import { HistoryService } from "./history.service";
import { SummaryService } from "./summary.service";
import { OracleService } from "./oracle.service";
import { ConfigFileService } from "../config/config-file.service";
import { SimulationPreparationService } from "../config/simulation-preparation.service";
import { SimulationSeedService } from "../config/simulation-seed.service";
import { FroniusService } from "../fronius/fronius.service";
import { StorageModule } from "../storage/storage.module";

@Module({
  imports: [StorageModule],
  providers: [
    SimulationService,
    ForecastService,
    HistoryService,
    SummaryService,
    OracleService,
    SimulationSeedService,
    SimulationPreparationService,
    ConfigFileService,
    FroniusService,
  ],
  exports: [
    SimulationService,
    ForecastService,
    HistoryService,
    SummaryService,
    OracleService,
    SimulationSeedService,
    SimulationPreparationService,
    ConfigFileService,
    FroniusService,
  ],
})
export class SimulationModule {
}
