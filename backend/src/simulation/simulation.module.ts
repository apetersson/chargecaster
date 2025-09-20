import { Module } from "@nestjs/common";

import { SimulationService } from "./simulation.service.js";
import { StorageModule } from "../storage/storage.module.js";

@Module({
  imports: [StorageModule],
  providers: [SimulationService],
  exports: [SimulationService],
})
export class SimulationModule {}
