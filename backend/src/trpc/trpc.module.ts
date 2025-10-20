import { Module } from "@nestjs/common";

import { ChargecasterServicesModule } from "../chargecaster-services.module";
import { TrpcRouter } from "./trpc.router";

@Module({
  imports: [ChargecasterServicesModule],
  providers: [TrpcRouter],
  exports: [TrpcRouter],
})
export class TrpcModule {
}
