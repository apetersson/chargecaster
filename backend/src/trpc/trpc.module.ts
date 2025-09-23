import { Module } from "@nestjs/common";

import { TrpcRouter } from "./trpc.router";
import { SimulationModule } from "../simulation/simulation.module";

@Module({
  imports: [SimulationModule],
  providers: [TrpcRouter],
  exports: [TrpcRouter],
})
export class TrpcModule {
}
