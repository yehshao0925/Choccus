/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Default game mode when ?mode= is absent (see main.ts). Set at build time
   * for static, relay-less deploys (e.g. VITE_DEFAULT_MODE=solo for a
   * practice-only GitHub Pages build). Unset in dev/serve → online lobby.
   */
  readonly VITE_DEFAULT_MODE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
