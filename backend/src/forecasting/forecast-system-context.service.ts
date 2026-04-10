import { Inject, Injectable } from "@nestjs/common";

import { getBuildVersion } from "../build-info";
import { RuntimeConfigService } from "../config/runtime-config.service";
import { DemandForecastService } from "../config/demand-forecast.service";
import { ModelTrainingCoordinator } from "./model-training-coordinator.service";
import { PriceForecastArtifactService } from "./price-forecast-artifact.service";

@Injectable()
export class ForecastSystemContextService {
  constructor(
    @Inject(RuntimeConfigService) private readonly runtimeConfig: RuntimeConfigService,
    @Inject(DemandForecastService) private readonly demandForecastService: DemandForecastService,
    @Inject(ModelTrainingCoordinator) private readonly modelTrainingCoordinator: ModelTrainingCoordinator,
    @Inject(PriceForecastArtifactService) private readonly priceArtifactService: PriceForecastArtifactService,
  ) {}

  getContext() {
    const config = this.runtimeConfig.getDocumentRef();
    const loadRuntime = this.demandForecastService.getRuntimeMetadata(config);
    const loadTraining = this.modelTrainingCoordinator.getJobStatus("load-forecast");
    const priceTraining = this.modelTrainingCoordinator.getJobStatus("price-forecast");
    const priceArtifact = this.priceArtifactService.readActiveArtifact(config);

    return {
      backend_build_version: getBuildVersion(),
      load_forecast: {
        method: loadRuntime.method,
        active_source: loadTraining.lastPromotionDecision === "candidate_not_promoted" && loadRuntime.runtimeStatus === "serving"
          ? "candidate_not_promoted"
          : loadRuntime.activeSource,
        model_version: loadRuntime.modelVersion,
        feature_schema_version: loadRuntime.featureSchemaVersion,
        trained_at: loadRuntime.trainedAt,
        training_window_end: loadRuntime.trainingWindowEnd,
        runtime_status: loadTraining.trainingActive ? "training" : loadRuntime.runtimeStatus,
        last_promotion_decision: loadTraining.lastPromotionDecision,
        training_active: loadTraining.trainingActive,
        last_training_attempt_at: loadTraining.lastTrainingAttemptAt,
        last_training_result: loadTraining.lastTrainingResult,
        last_training_message: loadTraining.lastTrainingMessage,
      },
      price_forecast: {
        method: priceArtifact ? "catboost_model" : "unavailable",
        model_version: priceArtifact?.manifest.model_version ?? null,
        feature_schema_version: priceArtifact?.manifest.feature_schema_version ?? null,
        trained_at: priceArtifact?.manifest.trained_at ?? null,
        training_window_end: priceArtifact?.manifest.training_window.end ?? null,
        training_active: priceTraining.trainingActive,
        last_training_attempt_at: priceTraining.lastTrainingAttemptAt,
        last_training_result: priceTraining.lastTrainingResult,
        last_training_message: priceTraining.lastTrainingMessage,
      },
    };
  }
}
