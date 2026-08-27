import type { ModuleId, RuntimeMode } from "../world-state/types.js";

export interface RuntimeCapabilities {
  readonly mode: RuntimeMode;
  readonly canEmitNativeInput: boolean;
  readonly qaBannerRequired: boolean;
  readonly modules: Record<ModuleId, boolean>;
}

export interface QaArmingState {
  acknowledged: boolean;
  armed: boolean;
  emergencyStopLatched: boolean;
  dryRunDefault: boolean;
  allowlistedProcessNames: string[];
  allowlistedWindowTitleIncludes: string[];
  realmAllowlist?: string[];
  accountAliasAllowlist?: string[];
  characterAliasAllowlist?: string[];
  scenarioAllowlist?: string[];
}

const PUBLIC_MODULES: Record<ModuleId, boolean> = {
  follow: false,
  loot: false,
  inventory: false,
  stash: false,
  listing: false,
  trade: false,
  recovery: false,
  orchestrator: false,
  perception: true,
  input: false,
};

const QA_MODULES: Record<ModuleId, boolean> = {
  follow: true,
  loot: true,
  inventory: true,
  stash: true,
  listing: true,
  trade: true,
  recovery: true,
  orchestrator: true,
  perception: true,
  input: true,
};

export function createCapabilities(mode: RuntimeMode): RuntimeCapabilities {
  if (mode === "public-companion") {
    return Object.freeze({
      mode,
      canEmitNativeInput: false,
      qaBannerRequired: false,
      modules: Object.freeze({ ...PUBLIC_MODULES }),
    });
  }
  return Object.freeze({
    mode,
    canEmitNativeInput: true,
    qaBannerRequired: true,
    modules: Object.freeze({ ...QA_MODULES }),
  });
}
