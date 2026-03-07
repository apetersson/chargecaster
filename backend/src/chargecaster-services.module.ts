import { Module } from "@nestjs/common";

import { SimulationService } from "./simulation/simulation.service";
import { ForecastService } from "./simulation/forecast.service";
import { HistoryService } from "./simulation/history.service";
import { SummaryService } from "./simulation/summary.service";
import { OracleService } from "./simulation/oracle.service";
import { BacktestService } from "./simulation/backtest.service";
import { BacktestMaterializationService } from "./simulation/backtest-materialization.service";
import { DAILY_BACKTEST_STRATEGY } from "./simulation/daily-backtest.strategy";
import { ContinuousBacktestStrategy } from "./simulation/continuous-backtest.strategy";
import { DailyIsolatedBacktestStrategy } from "./simulation/daily-isolated-backtest.strategy";
import { ConfigFileService } from "./config/config-file.service";
import { SimulationPreparationService } from "./config/simulation-preparation.service";
import { SimulationSeedService } from "./config/simulation-seed.service";
import { SimulationConfigFactory } from "./config/simulation-config.factory";
import { MarketDataService } from "./config/market-data.service";
import { EvccDataService } from "./config/evcc-data.service";
import { ForecastAssemblyService } from "./config/forecast-assembly.service";
import { FroniusService } from "./fronius/fronius.service";
import { OptimisationCommandTranslator } from "./hardware/optimisation-command-translator.service";
import { StorageModule } from "./storage/storage.module";
import { RuntimeConfigService } from "./config/runtime-config.service";

@Module({
  imports: [StorageModule],
  providers: [
    SimulationService,
    ForecastService,
    HistoryService,
    SummaryService,
    OracleService,
    DailyIsolatedBacktestStrategy,
    ContinuousBacktestStrategy,
    {
      provide: DAILY_BACKTEST_STRATEGY,
      useExisting: ContinuousBacktestStrategy,
    },
    BacktestService,
    BacktestMaterializationService,
    SimulationSeedService,
    SimulationPreparationService,
    ConfigFileService,
    SimulationConfigFactory,
    MarketDataService,
    EvccDataService,
    ForecastAssemblyService,
    FroniusService,
    OptimisationCommandTranslator,
    RuntimeConfigService,
  ],
  exports: [
    SimulationService,
    ForecastService,
    HistoryService,
    SummaryService,
    OracleService,
    BacktestService,
    BacktestMaterializationService,
    SimulationSeedService,
    SimulationPreparationService,
    ConfigFileService,
    SimulationConfigFactory,
    MarketDataService,
    EvccDataService,
    ForecastAssemblyService,
    FroniusService,
    OptimisationCommandTranslator,
    RuntimeConfigService,
  ],
})
export class ChargecasterServicesModule {}
