import { Inject, Injectable, Logger } from "@nestjs/common";
import { TRPCError, initTRPC, type AnyProcedure, type AnyRouter, type ProcedureType } from "@trpc/server";
import { z } from "zod";

import type { RawForecastEntry, SimulationConfig } from "@chargecaster/domain";
import { SimulationService } from "../simulation/simulation.service";
import { ForecastService } from "../simulation/forecast.service";
import { HistoryService } from "../simulation/history.service";
import { SummaryService } from "../simulation/summary.service";
import { OracleService } from "../simulation/oracle.service";
import { BacktestService } from "../simulation/backtest.service";
import { RuntimeConfigService } from "../config/runtime-config.service";
import { PLANNING_VARIANTS } from "../config/runtime-config.service";
import { SimulationConfigFactory } from "../config/simulation-config.factory";
import { SimulationSeedService } from "../config/simulation-seed.service";
import { getBuildVersion } from "../build-info";

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
  allow_battery_export: z.boolean().optional(),
});

const configSchema: z.ZodType<SimulationConfig> = z.object({
  battery: batterySchema,
  price: priceSchema,
  logic: logicSchema,
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

const planningVariantSchema = z.enum(PLANNING_VARIANTS);
const summaryInputSchema = z.object({
  previewHours: z.number().int().min(1).max(120).optional(),
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
    @Inject(BacktestService) private readonly backtestService: BacktestService,
    @Inject(RuntimeConfigService) private readonly runtimeConfig: RuntimeConfigService,
    @Inject(SimulationConfigFactory) private readonly configFactory: SimulationConfigFactory,
    @Inject(SimulationSeedService) private readonly simulationSeedService: SimulationSeedService,
  ) {
    this.router = t.router({
      health: t.procedure.query(() => {
        this.logger.verbose("tRPC.health heartbeat");
        // Keep the backend build visible to the frontend so the UI can spot
        // mismatched frontend/backend deployments.
        return {status: "ok", version: getBuildVersion()};
      }),
      dashboard: t.router({
        summary: t.procedure.input(summaryInputSchema.optional()).query(({input}) => {
          this.logger.log("tRPC.dashboard.summary requested");
          return this.summaryService.toSummary(this.simulationService.ensureSeedFromFixture(), {
            previewHours: input?.previewHours ?? null,
          });
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
        demandForecast: t.procedure.query(() => {
          this.logger.log("tRPC.dashboard.demandForecast requested");
          const snap = this.simulationService.ensureSeedFromFixture();
          return {
            generated_at: snap.timestamp,
            entries: Array.isArray(snap.demand_forecast) ? snap.demand_forecast : [],
          };
        }),
        oracle: t.procedure.query(() => {
          this.logger.log("tRPC.dashboard.oracle requested");
          return this.oracleService.build(this.simulationService.ensureSeedFromFixture());
        }),
        planningVariant: t.procedure.query(() => {
          const variant = this.runtimeConfig.getPlanningVariant();
          const dryRunEnabled = this.runtimeConfig.isDryRunEnabled();
          this.logger.log(`tRPC.dashboard.planningVariant requested (${variant}, dry_run=${dryRunEnabled})`);
          return {variant, dryRunEnabled};
        }),
        setPlanningVariant: t.procedure
          .input(z.object({variant: planningVariantSchema}))
          .mutation(async ({input}) => {
            const {variant} = input;
            if (!this.runtimeConfig.isDryRunEnabled()) {
              this.logger.warn(`Rejected planning variant switch (${variant}) because dry_run=false`);
              throw new TRPCError({
                code: "FORBIDDEN",
                message: "Planning variant switching is only available in dry mode.",
              });
            }
            this.logger.log(`tRPC.dashboard.setPlanningVariant requested (${variant})`);
            this.runtimeConfig.setPlanningVariant(variant);
            await this.simulationSeedService.seedFromConfig();
            return {
              variant: this.runtimeConfig.getPlanningVariant(),
              dryRunEnabled: this.runtimeConfig.isDryRunEnabled(),
            };
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
          const liveSocLabel = typeof input.liveState.battery_soc === "number" ? input.liveState.battery_soc : "n/a";
          this.logger.log(
            `tRPC.dashboard.runSimulation requested (forecast=${input.forecast.length}, liveSoc=${liveSocLabel})`,
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
        backtest: t.procedure.query(() => {
          this.logger.log("tRPC.dashboard.backtest requested");
          const snapshot = this.simulationService.ensureSeedFromFixture();
          const configDocument = this.runtimeConfig.getDocumentRef();
          const simConfig = this.configFactory.create(configDocument);
          return this.backtestService.run(snapshot, configDocument, simConfig);
        }),
        backtestHistory: t.procedure
          .input(z.object({ limit: z.number().int().min(1).max(31).default(7), skip: z.number().int().min(0).default(0) }))
          .query(({ input }) => {
            this.logger.log(`tRPC.dashboard.backtestHistory requested (limit=${input.limit}, skip=${input.skip})`);
            const snapshot = this.simulationService.ensureSeedFromFixture();
            const configDocument = this.runtimeConfig.getDocumentRef();
            const simConfig = this.configFactory.create(configDocument);
            return this.backtestService.runDailyHistory(snapshot, configDocument, simConfig, input.limit, input.skip);
          }),
        backtestHistoryDetail: t.procedure
          .input(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }))
          .query(({ input }) => {
            this.logger.log(`tRPC.dashboard.backtestHistoryDetail requested (date=${input.date})`);
            const snapshot = this.simulationService.ensureSeedFromFixture();
            const configDocument = this.runtimeConfig.getDocumentRef();
            const simConfig = this.configFactory.create(configDocument);
            return this.backtestService.getDailyHistoryDetail(snapshot, configDocument, simConfig, input.date);
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
