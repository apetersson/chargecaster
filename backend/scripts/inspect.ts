import { resolve } from 'node:path';
import { ConfigSyncService } from '../src/config/config-sync.service.ts';
import { SimulationService } from '../src/simulation/simulation.service.ts';
import { StorageService } from '../src/storage/storage.service.ts';

async function main() {
  const storage = new StorageService();
  const simulation = new SimulationService(storage);
  const configService = new ConfigSyncService(simulation, {
    applyOptimization: async () => {},
  } as any);

  const configPath = resolve(process.cwd(), '../config.local.yaml');
  const config = await (configService as any).loadConfigFile(configPath);
  const prepared = await (configService as any).prepareSimulation(config);
  console.log('forecast slots:', prepared.forecast.length);
  console.log('first slot:', prepared.forecast[0]);
  console.log('price snapshot:', prepared.priceSnapshot);
  console.log('warnings:', prepared.warnings);
  console.log('errors:', prepared.errors);
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
