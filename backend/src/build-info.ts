const DEFAULT_BUILD_VERSION = "dev";

export function getBuildVersion(): string {
  const candidate = process.env.CHARGECASTER_BUILD_VERSION?.trim();
  return candidate && candidate.length > 0 ? candidate : DEFAULT_BUILD_VERSION;
}
