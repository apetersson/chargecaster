/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_BUILD_VERSION?: string;
  readonly VITE_TRPC_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
