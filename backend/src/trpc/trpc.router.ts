import { Inject, Injectable, Logger } from "@nestjs/common";
import { initTRPC, type AnyProcedure, type AnyRouter, type ProcedureType } from "@trpc/server";
import { z } from "zod";

import type { RawForecastEntry, SimulationConfig } from "@chargecaster/domain";
import type { BacktestSeriesResponse } from "@chargecaster/domain";
import { SimulationService } from "../simulation/simulation.service";
import { ForecastService } from "../simulation/forecast.service";
import { HistoryService } from "../simulation/history.service";
import { SummaryService } from "../simulation/summary.service";
import { OracleService } from "../simulation/oracle.service";
import { BacktestSavingsService } from "../simulation/backtest.service";
import { SimulationConfigFactory } from "../config/simulation-config.factory";
import { RuntimeConfigService } from "../config/runtime-config.service";

interface TrpcContext {
  simulationService?: SimulationService;
}

const t = initTRPC.context<TrpcContext>().create();

const batterySchema = z.object({
  capacity_kwh: z.number().positive(),
  max_charge_power_w: z.number().nonnegative(),
  auto_mode_floor_soc: z.number().min(0).max(100).optional(),
  max_charge_power_solar_w: z.number().nonnegative().optional(),
  max_discharge_power_w: z.number().nonnegative().optional(),
  max_charge_soc_percent: z.number().min(0).max(100).optional(),
});

const priceSchema = z.object({
  grid_fee_eur_per_kwh: z.number().nonnegative().optional(),
  feed_in_tariff_eur_per_kwh: z.number().nonnegative().optional(),
});

const logicSchema = z.object({
  interval_seconds: z.number().positive().optional(),
  min_hold_minutes: z.number().nonnegative().optional(),
  house_load_w: z.number().nonnegative().optional(),
  allow_battery_export: z.boolean().optional(),
});

const solarSchema = z
  .object({
    direct_use_ratio: z.number().min(0).max(1).optional(),
  })
  .optional();

const configSchema: z.ZodType<SimulationConfig> = z.object({
  battery: batterySchema,
  price: priceSchema,
  logic: logicSchema,
  solar: solarSchema,
});

const jsonScalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const dateLike = z.union([z.string(), z.number(), z.date(), z.null()]);

const forecastEntrySchema = z.object({
  start: dateLike.optional(),
  end: dateLike.optional(),
  from: dateLike.optional(),
  to: dateLike.optional(),
  price: jsonScalar.optional(),
  value: jsonScalar.optional(),
  unit: z.string().nullable().optional(),
  price_unit: z.string().nullable().optional(),
  value_unit: z.string().nullable().optional(),
  duration_hours: jsonScalar.optional(),
  duration_minutes: jsonScalar.optional(),
});

const runSimulationInputSchema = z.object({
  config: configSchema,
  liveState: z.object({battery_soc: z.number().optional()}).default({}),
  forecast: z.array(forecastEntrySchema),
});

const historyInputSchema = z.object({
  limit: z.number().int().min(1).max(500).optional(),
});

@Injectable()
export class TrpcRouter {
  public readonly router;
  private readonly logger = new Logger(TrpcRouter.name);

  constructor(
    @Inject(SimulationService) private readonly simulationService: SimulationService,
    @Inject(ForecastService) private readonly forecastService: ForecastService,
    @Inject(HistoryService) private readonly historyService: HistoryService,
    @Inject(SummaryService) private readonly summaryService: SummaryService,
    @Inject(OracleService) private readonly oracleService: OracleService,
    @Inject(BacktestSavingsService) private readonly backtestService: BacktestSavingsService,
    @Inject(RuntimeConfigService) private readonly configState: RuntimeConfigService,
    @Inject(SimulationConfigFactory) private readonly configFactory: SimulationConfigFactory,
  ) {
    this.router = t.router({
      health: t.procedure.query(() => {
        this.logger.verbose("tRPC.health heartbeat");
        return {status: "ok"};
      }),
      dashboard: t.router({
        summary: t.procedure.query(() => {
          this.logger.log("tRPC.dashboard.summary requested");
          return this.summaryService.toSummary(this.simulationService.ensureSeedFromFixture());
        }),
        history: t.procedure.input(historyInputSchema.optional()).query(({input}) => {
          const limit = input?.limit ?? 96;
          this.logger.log(`tRPC.dashboard.history requested (limit=${limit})`);
          return this.historyService.getHistory(limit);
        }),
        forecast: t.procedure.query(() => {
          this.logger.log("tRPC.dashboard.forecast requested");
          const snap = this.simulationService.ensureSeedFromFixture();
          return this.forecastService.buildResponse(snap.timestamp, Array.isArray(snap.forecast_eras) ? snap.forecast_eras : []);
        }),
        oracle: t.procedure.query(() => {
          this.logger.log("tRPC.dashboard.oracle requested");
          return this.oracleService.build(this.simulationService.ensureSeedFromFixture());
        }),
        backtest24h: t.procedure.query((): BacktestSeriesResponse => {
          this.logger.log("tRPC.dashboard.backtest24h requested");
          this.logger.verbose("Loading runtime config for backtest calculations");
          const doc = this.configState.getDocument();
          const simConfig = this.configFactory.create(doc);
          const series = this.backtestService.buildSeries(simConfig, { windowHours: 24, historyLimit: 1000 });
          if (series) {
            return series;
          }
          const nowIso = new Date().toISOString();
          return { generated_at: nowIso, window_start: nowIso, window_end: nowIso, points: [] };
        }),
        snapshot: t.procedure.query(({ctx}) => {
          const service = ctx.simulationService ?? this.simulationService;
          this.logger.log("tRPC.dashboard.snapshot requested");
          const latest = service.getLatestSnapshot();
          if (latest) {
            return latest;
          }
          return service.ensureSeedFromFixture();
        }),
        runSimulation: t.procedure.input(runSimulationInputSchema).mutation(({ctx, input}) => {
          const service = ctx.simulationService ?? this.simulationService;
          this.logger.log(
            `tRPC.dashboard.runSimulation requested (forecast=${input.forecast.length}, liveSoc=${
              typeof input.liveState?.battery_soc === "number" ? input.liveState.battery_soc : "n/a"
            })`,
          );
          return service.runSimulation({
            config: input.config,
            liveState: input.liveState,
            forecast: input.forecast as RawForecastEntry[],
          });
        }),
        loadFixture: t.procedure.mutation(({ctx}) => {
          const service = ctx.simulationService ?? this.simulationService;
          this.logger.log("tRPC.dashboard.loadFixture requested");
          return service.ensureSeedFromFixture();
        }),
      }),
    });
  }

  public listProcedures(): { path: string; type: ProcedureType }[] {
    return this.collectProcedures(this.router);
  }

  private collectProcedures(router: AnyRouter, parent = ""): { path: string; type: ProcedureType }[] {
    const result: { path: string; type: ProcedureType }[] = [];
    const entries = Object.entries(router._def.procedures as Record<string, unknown>);

    for (const [key, value] of entries) {
      const path = parent ? `${parent}.${key}` : key;
      if (this.isRouter(value)) {
        result.push(...this.collectProcedures(value, path));
        continue;
      }

      const procedure = value as AnyProcedure;
      result.push({path, type: procedure._def.type});
    }

    return result;
  }

  private isRouter(value: unknown): value is AnyRouter {
    if (typeof value !== "object" || value === null) {
      return false;
    }
    const rawDef = (value as { _def?: unknown })._def;
    if (typeof rawDef !== "object" || rawDef === null) {
      return false;
    }
    return Object.prototype.hasOwnProperty.call(rawDef, "procedures");
  }
}

export type AppRouter = TrpcRouter["router"];
