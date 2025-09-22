import { Inject, Injectable } from "@nestjs/common";
import { initTRPC } from "@trpc/server";
import { z } from "zod";

import type { RawForecastEntry, SimulationConfig } from "../simulation/types.ts";
import { SimulationService } from "../simulation/simulation.service.ts";
import { ForecastService } from "../simulation/forecast.service.ts";
import { HistoryService } from "../simulation/history.service.ts";
import { SummaryService } from "../simulation/summary.service.ts";
import { OracleService } from "../simulation/oracle.service.ts";

interface TrpcContext {
  simulationService?: SimulationService;
}

const t = initTRPC.context<TrpcContext>().create();

const batterySchema = z.object({
  capacity_kwh: z.number().positive(),
  max_charge_power_w: z.number().nonnegative(),
  auto_mode_floor_soc: z.number().min(0).max(100).optional(),
});

const priceSchema = z.object({
  grid_fee_eur_per_kwh: z.number().nonnegative().optional(),
  network_tariff_eur_per_kwh: z.number().nonnegative().optional(),
});

const logicSchema = z.object({
  interval_seconds: z.number().positive().optional(),
  min_hold_minutes: z.number().nonnegative().optional(),
  house_load_w: z.number().nonnegative().optional(),
});

const solarSchema = z
  .object({
    direct_use_ratio: z.number().min(0).max(1).optional(),
    max_charge_power_w: z.number().nonnegative().optional(),
  })
  .optional();

const configSchema: z.ZodType<SimulationConfig> = z.object({
  battery: batterySchema,
  price: priceSchema,
  logic: logicSchema,
  solar: solarSchema,
  state: z.object({ path: z.string().optional() }).optional(),
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
  liveState: z.object({ battery_soc: z.number().optional() }).default({}),
  forecast: z.array(forecastEntrySchema),
});

const historyInputSchema = z.object({
  limit: z.number().int().min(1).max(500).optional(),
});

@Injectable()
export class TrpcRouter {
  public readonly router;

  constructor(
    @Inject(SimulationService) private readonly simulationService: SimulationService,
    @Inject(ForecastService) private readonly forecastService: ForecastService,
    @Inject(HistoryService) private readonly historyService: HistoryService,
    @Inject(SummaryService) private readonly summaryService: SummaryService,
    @Inject(OracleService) private readonly oracleService: OracleService,
  ) {
    this.router = t.router({
      health: t.procedure.query(() => ({ status: "ok" })),
      dashboard: t.router({
        summary: t.procedure.query(() => this.summaryService.toSummary(this.simulationService.ensureSeedFromFixture())),
        history: t.procedure.input(historyInputSchema.optional()).query(({ input }) => {
          const limit = input?.limit ?? 96;
          return this.historyService.getHistory(limit);
        }),
        forecast: t.procedure.query(() => {
          const snap = this.simulationService.ensureSeedFromFixture();
          return this.forecastService.buildResponse(snap.timestamp, Array.isArray(snap.forecast_eras) ? snap.forecast_eras : []);
        }),
        oracle: t.procedure.query(() => this.oracleService.build(this.simulationService.ensureSeedFromFixture())),
        snapshot: t.procedure.query(({ ctx }) => {
          const service = ctx.simulationService ?? this.simulationService;
          const latest = service.getLatestSnapshot();
          if (latest) {
            return latest;
          }
          return service.ensureSeedFromFixture();
        }),
        runSimulation: t.procedure.input(runSimulationInputSchema).mutation(({ ctx, input }) => {
          const service = ctx.simulationService ?? this.simulationService;
          return service.runSimulation({
            config: input.config,
            liveState: input.liveState,
            forecast: input.forecast as RawForecastEntry[],
          });
        }),
        loadFixture: t.procedure.mutation(({ ctx }) => {
          const service = ctx.simulationService ?? this.simulationService;
          return service.ensureSeedFromFixture();
        }),
      }),
    });
  }
}

export type AppRouter = TrpcRouter["router"];
