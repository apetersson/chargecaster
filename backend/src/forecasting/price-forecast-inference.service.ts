import { Inject, Injectable, Logger } from "@nestjs/common";

import type { ConfigDocument } from "../config/schemas";
import { ensureCatBoostRuntimeLibraryPath } from "./catboost-runtime";
import { PriceForecastArtifactService, type ActivePriceForecastArtifact } from "./price-forecast-artifact.service";

type CatBoostModelInstance = {
  loadModel: (path: string) => void;
  predict: (floatFeatures: number[][], catFeatures?: string[][]) => number[] | Float64Array | number;
};

type CatBoostModule = {
  Model: new () => CatBoostModelInstance;
};

@Injectable()
export class PriceForecastInferenceService {
  private readonly logger = new Logger(PriceForecastInferenceService.name);
  private cachedArtifactPath: string | null = null;
  private cachedModel: CatBoostModelInstance | null = null;
  private catBoostModule: CatBoostModule | null | undefined;

  constructor(
    @Inject(PriceForecastArtifactService) private readonly artifactService: PriceForecastArtifactService,
  ) {}

  getActiveArtifact(config: ConfigDocument): ActivePriceForecastArtifact | null {
    return this.artifactService.readActiveArtifact(config);
  }

  async predict(config: ConfigDocument, floatFeatures: number[][]): Promise<{
    predictions: number[];
    artifact: ActivePriceForecastArtifact;
  } | null> {
    const artifact = this.getActiveArtifact(config);
    if (!artifact || floatFeatures.length === 0) {
      return null;
    }

    const model = await this.loadModel(artifact);
    if (!model) {
      return null;
    }

    const result = model.predict(floatFeatures);
    const predictions = normalizePredictions(result, floatFeatures.length);
    if (predictions.length !== floatFeatures.length) {
      throw new Error(`CatBoost prediction length mismatch (${predictions.length} != ${floatFeatures.length})`);
    }

    return { predictions, artifact };
  }

  private async loadModel(artifact: ActivePriceForecastArtifact): Promise<CatBoostModelInstance | null> {
    if (this.cachedArtifactPath === artifact.modelPath && this.cachedModel) {
      return this.cachedModel;
    }

    const moduleRef = await this.loadCatBoostModule();
    if (!moduleRef) {
      return null;
    }

    const model = new moduleRef.Model();
    model.loadModel(artifact.modelPath);
    this.cachedArtifactPath = artifact.modelPath;
    this.cachedModel = model;
    this.logger.log(`Loaded CatBoost price-forecast artifact ${artifact.manifest.model_version}`);
    return model;
  }

  private async loadCatBoostModule(): Promise<CatBoostModule | null> {
    if (this.catBoostModule !== undefined) {
      return this.catBoostModule;
    }
    try {
      ensureCatBoostRuntimeLibraryPath();
      const moduleRef = await import("catboost");
      this.catBoostModule = ("default" in moduleRef ? moduleRef.default : moduleRef) as CatBoostModule;
    } catch (error) {
      this.catBoostModule = null;
      this.logger.warn(`CatBoost runtime unavailable; price forecast will fall back: ${String(error)}`);
    }
    return this.catBoostModule;
  }
}

function normalizePredictions(raw: number[] | Float64Array | number, expectedLength: number): number[] {
  if (typeof raw === "number") {
    return expectedLength <= 1 ? [raw] : Array.from({ length: expectedLength }, () => raw);
  }
  return Array.from(raw);
}
