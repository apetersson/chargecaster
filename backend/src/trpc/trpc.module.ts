import { Module } from "@nestjs/common";

import { TrpcRouter } from "./trpc.router";
import { ChargecasterServicesModule } from "../chargecaster-services.module";

@Module({
  imports: [ChargecasterServicesModule],
  providers: [TrpcRouter],
  exports: [TrpcRouter],
})
export class TrpcModule {
}
