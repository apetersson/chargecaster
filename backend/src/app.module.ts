import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";

import { SimulationModule } from "./simulation/simulation.module";
import { StorageModule } from "./storage/storage.module";
import { TrpcModule } from "./trpc/trpc.module";

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
export class AppModule {
}
