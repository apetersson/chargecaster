import { Module } from "@nestjs/common";

import { StorageService } from "./storage.service.ts";

@Module({
  providers: [StorageService],
  exports: [StorageService],
})
export class StorageModule {}
