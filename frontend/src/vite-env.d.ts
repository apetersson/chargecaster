/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_TRPC_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

interface Window {
  __CHARGECASTER_BOOT_READY__?: () => void;
}
