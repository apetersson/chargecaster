type ReloadAppOptions = {
  resetCaches?: boolean;
};

function buildReloadUrl(): string {
  const url = new URL(window.location.href);
  url.searchParams.set("_reload", String(Date.now()));
  return url.toString();
}

async function clearAppCaches(): Promise<void> {
  if ("serviceWorker" in navigator) {
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(registrations.map((registration) => registration.unregister()));
  }

  if ("caches" in window) {
    const cacheNames = await caches.keys();
    await Promise.all(cacheNames.map((cacheName) => caches.delete(cacheName)));
  }
}

export async function reloadApplication(options: ReloadAppOptions = {}): Promise<void> {
  if (options.resetCaches) {
    await clearAppCaches();
  }

  window.location.replace(buildReloadUrl());
}
