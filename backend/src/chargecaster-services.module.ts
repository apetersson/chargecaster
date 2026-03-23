import { Module } from "@nestjs/common";

import { SimulationService } from "./simulation/simulation.service";
import { ForecastService } from "./simulation/forecast.service";
import { HistoryService } from "./simulation/history.service";
import { SummaryService } from "./simulation/summary.service";
import { OracleService } from "./simulation/oracle.service";
import { BatteryEfficiencyService } from "./simulation/battery-efficiency.service";
import { BacktestService } from "./simulation/backtest.service";
import { BacktestMaterializationService } from "./simulation/backtest-materialization.service";
import { DAILY_BACKTEST_STRATEGY } from "./simulation/daily-backtest.strategy";
import { ContinuousBacktestStrategy } from "./simulation/continuous-backtest.strategy";
import { DailyIsolatedBacktestStrategy } from "./simulation/daily-isolated-backtest.strategy";
import { ConfigFileService } from "./config/config-file.service";
import { SimulationPreparationService } from "./config/simulation-preparation.service";
import { SimulationSeedService } from "./config/simulation-seed.service";
import { SimulationConfigFactory } from "./config/simulation-config.factory";
import { ConfigHistoryService } from "./config/config-history.service";
import { DynamicPriceConfigService } from "./config/dynamic-price-config.service";
import { AwattarSunnyFeedInPriceProvider } from "./config/price-providers/awattar-sunny-feed-in-price.provider";
import { AwattarSunnySpotFeedInPriceProvider } from "./config/price-providers/awattar-sunny-spot-feed-in-price.provider";
import { EControlGridFeePriceProvider } from "./config/price-providers/e-control-grid-fee-price.provider";
import { MarketDataService } from "./config/market-data.service";
import { EvccDataService } from "./config/evcc-data.service";
import { ForecastAssemblyService } from "./config/forecast-assembly.service";
import { WeatherService } from "./config/weather.service";
import { OpenMeteoSolarForecastService } from "./config/open-meteo-solar-forecast.service";
import { SolarForecastCalibrationService } from "./config/solar-forecast-calibration.service";
import { DemandForecastService } from "./config/demand-forecast.service";
import { LoadForecastArtifactService } from "./forecasting/load-forecast-artifact.service";
import { LoadForecastInferenceService } from "./forecasting/load-forecast-inference.service";
import { ModelTrainingCoordinator } from "./forecasting/model-training-coordinator.service";
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
    BatteryEfficiencyService,
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
    ConfigHistoryService,
    EControlGridFeePriceProvider,
    AwattarSunnyFeedInPriceProvider,
    AwattarSunnySpotFeedInPriceProvider,
    DynamicPriceConfigService,
    MarketDataService,
    EvccDataService,
    ForecastAssemblyService,
    WeatherService,
    OpenMeteoSolarForecastService,
    SolarForecastCalibrationService,
    LoadForecastArtifactService,
    LoadForecastInferenceService,
    ModelTrainingCoordinator,
    DemandForecastService,
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
    BatteryEfficiencyService,
    BacktestService,
    BacktestMaterializationService,
    SimulationSeedService,
    SimulationPreparationService,
    ConfigFileService,
    SimulationConfigFactory,
    ConfigHistoryService,
    EControlGridFeePriceProvider,
    AwattarSunnyFeedInPriceProvider,
    AwattarSunnySpotFeedInPriceProvider,
    DynamicPriceConfigService,
    MarketDataService,
    EvccDataService,
    ForecastAssemblyService,
    WeatherService,
    OpenMeteoSolarForecastService,
    SolarForecastCalibrationService,
    LoadForecastArtifactService,
    LoadForecastInferenceService,
    ModelTrainingCoordinator,
    DemandForecastService,
    FroniusService,
    OptimisationCommandTranslator,
    RuntimeConfigService,
  ],
})
export class ChargecasterServicesModule {}
