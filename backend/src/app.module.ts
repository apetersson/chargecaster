import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";

import { SimulationModule } from "./simulation/simulation.module.ts";
import { StorageModule } from "./storage/storage.module.ts";
import { TrpcModule } from "./trpc/trpc.module.ts";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [".env", "../.env", "../../.env"],
      cache: true,
    }),
    StorageModule,
    SimulationModule,
    TrpcModule,
  ],
})
export class AppModule {}
