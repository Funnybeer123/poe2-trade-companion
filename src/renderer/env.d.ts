/// <reference types="vite/client" />

import type { Poe2Bridge } from "../shared/ipc.js";

declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<object, object, unknown>;
  export default component;
}

declare global {
  const __POE2_BUILD_MODE__: "public-companion" | "authorized-qa";

  interface Window {
    poe2?: Poe2Bridge;
  }
}

export {};
