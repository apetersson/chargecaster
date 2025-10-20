import type { ConfigDocument } from "./schemas";

let runtimeConfig: ConfigDocument | null = null;

export function setRuntimeConfig(document: ConfigDocument): void {
  runtimeConfig = document;
}

export function getRuntimeConfig(): ConfigDocument | null {
  return runtimeConfig;
}
