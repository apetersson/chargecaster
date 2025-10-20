import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";

import { ChargecasterServicesModule } from "./chargecaster-services.module";
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
    ChargecasterServicesModule,
    TrpcModule,
  ],
})
export class AppModule {
}
