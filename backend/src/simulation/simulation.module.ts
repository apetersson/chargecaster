import { Module } from "@nestjs/common";

import { SimulationService } from "./simulation.service";
import { ForecastService } from "./forecast.service";
import { HistoryService } from "./history.service";
import { SummaryService } from "./summary.service";
import { OracleService } from "./oracle.service";
import { ConfigFileService } from "../config/config-file.service";
import { SimulationPreparationService } from "../config/simulation-preparation.service";
import { SimulationSeedService } from "../config/simulation-seed.service";
import { SimulationConfigFactory } from "../config/simulation-config.factory";
import { MarketDataService } from "../config/market-data.service";
import { EvccDataService } from "../config/evcc-data.service";
import { ForecastAssemblyService } from "../config/forecast-assembly.service";
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
    SimulationConfigFactory,
    MarketDataService,
    EvccDataService,
    ForecastAssemblyService,
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
    SimulationConfigFactory,
    MarketDataService,
    EvccDataService,
    ForecastAssemblyService,
    FroniusService,
  ],
})
export class SimulationModule {
}
