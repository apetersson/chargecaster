import { ConfigSyncService } from "../src/config/config-sync.service";
import { SimulationService } from "../src/simulation/simulation.service";
import { FroniusService } from "../src/fronius/fronius.service";
import { StorageService } from "../src/storage/storage.service";

async function reseed() {
  const storage = new StorageService();
  const simulationService = new SimulationService(storage);
  const froniusService = new FroniusService();
  const configSyncService = new ConfigSyncService(simulationService, froniusService);

  const timeoutMs = Number(process.env.SEED_TIMEOUT_MS ?? 120_000);

  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`seedFromConfig timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    await Promise.race([
      configSyncService.seedFromConfig(),
      timeoutPromise,
    ]);
    console.log("Reseeding complete");
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    configSyncService.onModuleDestroy();
  }
}

void reseed().catch((error) => {
  console.error("Failed to reseed snapshot", error);
  process.exit(1);
});
