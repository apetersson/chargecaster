import { Injectable } from "@nestjs/common";

import type { ConfigDocument } from "./schemas";
import { getRuntimeConfig, setRuntimeConfig } from "./runtime-config";

export const PLANNING_VARIANTS = ["awattar-sunny", "awattar-sunny-spot"] as const;
export type PlanningVariant = (typeof PLANNING_VARIANTS)[number];

@Injectable()
export class RuntimeConfigService {
  private document: ConfigDocument;

  constructor() {
    const config = getRuntimeConfig();
    if (!config) {
      throw new Error("Runtime configuration not initialised");
    }
    this.document = config;
  }

  getDocument(): ConfigDocument {
    return JSON.parse(JSON.stringify(this.document)) as ConfigDocument;
  }

  getDocumentRef(): ConfigDocument {
    return this.document;
  }

  getPlanningVariant(): PlanningVariant {
    const configuredType = this.document.price?.feed_in?.type;
    if (configuredType === "awattar-sunny-spot") {
      return configuredType;
    }
    return "awattar-sunny";
  }

  isDryRunEnabled(): boolean {
    return this.document.dry_run ?? false;
  }

  shouldShowFeedInPriceBars(): boolean {
    return this.getPlanningVariant() === "awattar-sunny-spot" || this.isDryRunEnabled();
  }

  setPlanningVariant(variant: PlanningVariant): ConfigDocument {
    const next = this.getDocument();
    next.price ??= {};
    next.price.feed_in = {type: variant};
    this.document = next;
    setRuntimeConfig(next);
    return this.getDocument();
  }
}
