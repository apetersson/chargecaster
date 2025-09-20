import { Module } from "@nestjs/common";

import { TrpcRouter } from "./trpc.router.js";
import { SimulationModule } from "../simulation/simulation.module.js";

@Module({
  imports: [SimulationModule],
  providers: [TrpcRouter],
  exports: [TrpcRouter],
})
export class TrpcModule {}
