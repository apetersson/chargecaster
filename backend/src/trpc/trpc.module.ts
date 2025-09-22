import { Module } from "@nestjs/common";

import { TrpcRouter } from "./trpc.router.ts";
import { SimulationModule } from "../simulation/simulation.module.ts";

@Module({
  imports: [SimulationModule],
  providers: [TrpcRouter],
  exports: [TrpcRouter],
})
export class TrpcModule {}
