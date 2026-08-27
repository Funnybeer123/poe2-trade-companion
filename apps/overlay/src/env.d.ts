/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly POE2TC_MODE?: "public-companion" | "authorized-qa";
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

import type { CapabilitiesDto, Poe2tcPreloadApi, StopResultDto } from "@poe2tc/core/operator";

declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<object, object, unknown>;
  export default component;
}

declare global {
  interface Window {
    poe2tc?: Poe2tcPreloadApi;
    poe2tcBanner?: {
      getCapabilities(): Promise<CapabilitiesDto>;
      tripStop(): Promise<StopResultDto>;
    };
  }
}

export {};
