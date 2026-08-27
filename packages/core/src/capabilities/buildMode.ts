import type { RuntimeMode } from "../world-state/types.js";

export const COMPILE_TIME_MODE_ENV = "POE2TC_MODE";
export const RUNTIME_MODE_ENV = "POE2TC_RUNTIME_MODE";

export interface BuildModeSources {
  /** Baked at pack/compile time (`import.meta.env.POE2TC_MODE` / extraMetadata). */
  compileTimeMode?: string;
  /** Runtime request (`process.env.POE2TC_RUNTIME_MODE`). Ignored unless compile-time is QA. */
  runtimeMode?: string;
  /** Packaged public artifacts must not honor a raw env override. */
  packaged?: boolean;
}

function asRuntimeMode(value: string | undefined): RuntimeMode | undefined {
  return value === "authorized-qa" || value === "public-companion" ? value : undefined;
}

/**
 * Vite/Electron compile-time flag. Public packs bake `public-companion`.
 * A public artifact cannot become `authorized-qa` by setting runtime env.
 */
export function readCompileTimeMode(
  env: NodeJS.ProcessEnv = process.env,
  importMetaMode?: string,
): RuntimeMode {
  return asRuntimeMode(importMetaMode) ?? asRuntimeMode(env[COMPILE_TIME_MODE_ENV]) ?? "public-companion";
}

export function isQaBuildEnabled(compileTimeMode: string | undefined): boolean {
  return compileTimeMode === "authorized-qa";
}

/**
 * Public compile-time builds always resolve to `public-companion`.
 * QA compile-time builds honor an explicit runtime request, defaulting to `authorized-qa`.
 */
export function resolveRuntimeMode(sources: BuildModeSources = {}): RuntimeMode {
  const compileTime = asRuntimeMode(sources.compileTimeMode) ?? "public-companion";
  if (!isQaBuildEnabled(compileTime)) {
    return "public-companion";
  }
  const requested = asRuntimeMode(sources.runtimeMode);
  if (requested === "public-companion") {
    return "public-companion";
  }
  return "authorized-qa";
}

export function resolveRuntimeModeFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  extras: { importMetaMode?: string; packaged?: boolean; bakedMode?: string } = {},
): RuntimeMode {
  const compileTime =
    extras.bakedMode ?? readCompileTimeMode(env, extras.importMetaMode);
  return resolveRuntimeMode({
    compileTimeMode: compileTime,
    runtimeMode: env[RUNTIME_MODE_ENV],
    packaged: extras.packaged,
  });
}
