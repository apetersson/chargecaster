import { Inject, Injectable, Logger } from "@nestjs/common";

import type { HistoryPoint, RawForecastEntry, SimulationConfig } from "@chargecaster/domain";
import { describeError } from "@chargecaster/domain";
import { StorageService } from "../storage/storage.service";
import { AwattarSunnyFeedInPriceProvider } from "./price-providers/awattar-sunny-feed-in-price.provider";
import { AwattarSunnySpotFeedInPriceProvider } from "./price-providers/awattar-sunny-spot-feed-in-price.provider";
import { EControlGridFeePriceProvider } from "./price-providers/e-control-grid-fee-price.provider";
import type {
  FeedInTariffScheduleProvider,
  FeedInPriceProvider,
  GridFeePriceProvider,
} from "./price-providers/price-provider.types";
import type {
  ConfigDocument,
  FeedInProviderRef,
  GridFeeProviderRef,
} from "./schemas";
import {
  resolveConfiguredStaticFeedInTariffEurPerKwh,
  resolveConfiguredStaticGridFeeEurPerKwh,
} from "./schemas";

@Injectable()
export class DynamicPriceConfigService {
  private readonly logger = new Logger(DynamicPriceConfigService.name);
  private readonly gridFeeProvidersByType: Map<string, GridFeePriceProvider>;
  private readonly feedInProvidersByType: Map<string, FeedInPriceProvider>;
  private readonly feedInScheduleProvidersByType: Map<string, FeedInTariffScheduleProvider>;

  constructor(
    @Inject(StorageService) private readonly storage: StorageService,
    @Inject(EControlGridFeePriceProvider) eControlGridFeeProvider: EControlGridFeePriceProvider,
    @Inject(AwattarSunnyFeedInPriceProvider) awattarSunnyFeedInPriceProvider: AwattarSunnyFeedInPriceProvider,
    @Inject(AwattarSunnySpotFeedInPriceProvider) awattarSunnySpotFeedInPriceProvider: AwattarSunnySpotFeedInPriceProvider,
  ) {
    const gridFeeProviders = [
      eControlGridFeeProvider,
    ] satisfies GridFeePriceProvider[];
    this.gridFeeProvidersByType = new Map(gridFeeProviders.map((provider) => [provider.type, provider]));

    const feedInProviders = [
      awattarSunnyFeedInPriceProvider,
      awattarSunnySpotFeedInPriceProvider,
    ] satisfies FeedInPriceProvider[];
    this.feedInProvidersByType = new Map(feedInProviders.map((provider) => [provider.type, provider]));

    const scheduleProviders = [
      awattarSunnySpotFeedInPriceProvider,
    ] satisfies FeedInTariffScheduleProvider[];
    this.feedInScheduleProvidersByType = new Map(scheduleProviders.map((provider) => [provider.type, provider]));
  }

  async refreshAndApply(config: ConfigDocument, referenceDate: Date = new Date()): Promise<ConfigDocument> {
    await this.refresh(config, referenceDate);
    return this.applyStoredOverrides(config, referenceDate.toISOString());
  }

  async refresh(config: ConfigDocument, referenceDate: Date = new Date()): Promise<void> {
    const timeZone = this.resolveTimeZone(config);
    const tasks: Promise<void>[] = [];

    const gridFeeSelection = this.resolveGridFeeSelection(config);
    if (gridFeeSelection && gridFeeSelection.type !== "static") {
      const provider = this.gridFeeProvidersByType.get(gridFeeSelection.type);
      if (provider) {
        tasks.push(this.refreshGridFeeWithProvider(provider, config, referenceDate, timeZone));
      }
    }

    const feedInSelection = this.resolveFeedInSelection(config);
    if (feedInSelection && feedInSelection.type !== "static") {
      const provider = this.feedInProvidersByType.get(feedInSelection.type);
      if (provider) {
        tasks.push(this.refreshFeedInWithProvider(provider, config, referenceDate, timeZone));
      }
    }

    await Promise.all(tasks);
  }

  applyStoredOverrides(config: ConfigDocument, effectiveAt: string = new Date().toISOString()): ConfigDocument {
    const merged = JSON.parse(JSON.stringify(config)) as ConfigDocument;
    const overrides = this.getSelectedPriceOverrides(config, effectiveAt);
    merged.price ??= {};

    if (overrides.grid_fee_eur_per_kwh != null) {
      merged.price.grid_fee_eur_per_kwh = overrides.grid_fee_eur_per_kwh;
    }
    if (overrides.feed_in_tariff_eur_per_kwh != null) {
      merged.price.feed_in_tariff_eur_per_kwh = overrides.feed_in_tariff_eur_per_kwh;
    }

    return merged;
  }

  getSelectedPriceOverrides(
    config: ConfigDocument,
    effectiveAt: string,
  ): Partial<Record<"grid_fee_eur_per_kwh" | "feed_in_tariff_eur_per_kwh", number>> {
    const overrides: Partial<Record<"grid_fee_eur_per_kwh" | "feed_in_tariff_eur_per_kwh", number>> = {};
    const gridFeeSelection = this.resolveGridFeeSelection(config);
    if (gridFeeSelection) {
      if (gridFeeSelection.type === "static") {
        overrides.grid_fee_eur_per_kwh = resolveConfiguredStaticGridFeeEurPerKwh(config) ?? 0;
      } else if (typeof this.storage.getLatestDynamicPriceRecordAt === "function") {
        const match = this.storage.getLatestDynamicPriceRecordAt("grid_fee_eur_per_kwh", gridFeeSelection.type, effectiveAt);
        if (match) {
          overrides.grid_fee_eur_per_kwh = match.valueEurPerKwh;
        }
      }
    }

    const feedInSelection = this.resolveFeedInSelection(config);
    if (feedInSelection) {
      if (feedInSelection.type === "static") {
        overrides.feed_in_tariff_eur_per_kwh = resolveConfiguredStaticFeedInTariffEurPerKwh(config) ?? 0;
      } else if (typeof this.storage.getLatestDynamicPriceRecordAt === "function") {
        const match = this.storage.getLatestDynamicPriceRecordAt("feed_in_tariff_eur_per_kwh", feedInSelection.type, effectiveAt);
        if (match) {
          overrides.feed_in_tariff_eur_per_kwh = match.valueEurPerKwh;
        }
      }
    }

    return overrides;
  }

  buildFeedInTariffScheduleFromForecast(
    config: ConfigDocument,
    simulationConfig: SimulationConfig,
    forecast: RawForecastEntry[],
    referenceDate: Date = new Date(),
  ): (number | undefined)[] | null {
    const selection = this.resolveFeedInSelection(config);
    if (!selection || selection.type === "static") {
      return null;
    }
    const provider = this.feedInScheduleProvidersByType.get(selection.type);
    if (!provider) {
      return null;
    }
    return provider.buildTariffSchedule({
      config,
      simulationConfig,
      referenceDate,
      forecast,
    });
  }

  buildFeedInTariffScheduleFromHistory(
    config: ConfigDocument | undefined,
    simulationConfig: SimulationConfig,
    history: HistoryPoint[],
    referenceDate: Date = new Date(),
  ): (number | undefined)[] | null {
    if (!config) {
      return null;
    }
    const selection = this.resolveFeedInSelection(config);
    if (!selection || selection.type === "static") {
      return null;
    }
    const provider = this.feedInScheduleProvidersByType.get(selection.type);
    if (!provider) {
      return null;
    }
    return provider.buildTariffSchedule({
      config,
      simulationConfig,
      referenceDate,
      history,
    });
  }

  private async refreshGridFeeWithProvider(
    provider: GridFeePriceProvider,
    config: ConfigDocument,
    referenceDate: Date,
    timeZone: string,
  ): Promise<void> {
    try {
      await provider.refresh({
        config,
        referenceDate,
        storage: this.storage,
        timeZone,
      });
    } catch (error) {
      this.logger.warn(`Grid fee ${provider.type} refresh failed: ${describeError(error)}`);
    }
  }

  private async refreshFeedInWithProvider(
    provider: FeedInPriceProvider,
    config: ConfigDocument,
    referenceDate: Date,
    timeZone: string,
  ): Promise<void> {
    try {
      await provider.refresh({
        config,
        referenceDate,
        storage: this.storage,
        timeZone,
      });
    } catch (error) {
      this.logger.warn(`Feed-in ${provider.type} refresh failed: ${describeError(error)}`);
    }
  }

  private resolveTimeZone(config: ConfigDocument): string {
    const timeZone = config.location?.timezone?.trim();
    return timeZone && timeZone.length > 0 ? timeZone : "Europe/Vienna";
  }

  private resolveGridFeeSelection(config: ConfigDocument): GridFeeProviderRef | null {
    const explicit = config.price?.grid_fee;
    if (explicit) {
      return explicit;
    }

    if (resolveConfiguredStaticGridFeeEurPerKwh(config) != null) {
      return {
        type: "static",
        eur_per_kwh: resolveConfiguredStaticGridFeeEurPerKwh(config) ?? 0,
      };
    }

    const dynamic = config.price?.dynamic;
    if (dynamic?.e_control?.enabled || dynamic?.wiener_netze?.enabled) {
      return {type: "e-control"};
    }

    return null;
  }

  private resolveFeedInSelection(config: ConfigDocument): FeedInProviderRef | null {
    const explicit = config.price?.feed_in;
    if (explicit) {
      return explicit;
    }

    if (resolveConfiguredStaticFeedInTariffEurPerKwh(config) != null) {
      return {
        type: "static",
        eur_per_kwh: resolveConfiguredStaticFeedInTariffEurPerKwh(config) ?? 0,
      };
    }

    if (config.price?.dynamic?.awattar_sunny?.enabled) {
      return {type: "awattar-sunny"};
    }

    return null;
  }
}
