import {
  createFixtureMarketProvider,
  createFixtureReplayCatalog,
  createOperatorRuntime,
  createRedactingLogger,
  EmergencyStop,
  FileTraceSink,
  OPERATOR_SETTINGS_KEY,
  parseOperatorSettings,
  resolveRuntimeMode as resolveGatedRuntimeMode,
  type OperatorRuntime,
  type RuntimeMode,
} from "@poe2tc/core";
import { applyMigrations, openSqliteDatabase, SqliteSettingsStore } from "@poe2tc/persistence-sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPackagedMeta, readBakedCompileTimeMode } from "./buildFlags.js";

const desktopDir = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(desktopDir, "../..");

export function resolveDesktopCompileTimeMode(
  env: NodeJS.ProcessEnv = process.env,
  packagedAppPath?: string,
): RuntimeMode {
  const packagedMeta = packagedAppPath !== undefined ? loadPackagedMeta(packagedAppPath) : undefined;
  return readBakedCompileTimeMode(env, packagedMeta);
}

export function resolveRuntimeModeFromDesktop(
  env: NodeJS.ProcessEnv = process.env,
  packagedAppPath?: string,
): RuntimeMode {
  const compileTimeMode = resolveDesktopCompileTimeMode(env, packagedAppPath);
  return resolveGatedRuntimeMode({
    compileTimeMode,
    runtimeMode: env.POE2TC_RUNTIME_MODE,
    packaged: packagedAppPath !== undefined,
  });
}

export function resolveRuntimeMode(env: NodeJS.ProcessEnv = process.env): RuntimeMode {
  return resolveRuntimeModeFromDesktop(env);
}

export function createDesktopRuntime(options: {
  emergencyStop?: EmergencyStop;
  dbPath?: string;
  clipboard?: { readText(): string };
  hotkeyRegistered?: boolean;
  env?: NodeJS.ProcessEnv;
  packagedAppPath?: string;
  tracesPath?: string;
  fsyncTraces?: boolean;
}): OperatorRuntime {
  const env = options.env ?? process.env;
  const compileTimeMode = resolveDesktopCompileTimeMode(env, options.packagedAppPath);
  const db = openSqliteDatabase(options.dbPath ?? env.POE2TC_DB_PATH ?? ":memory:");
  applyMigrations(db, path.join(REPO_ROOT, "migrations"));
  const settingsStore = new SqliteSettingsStore(db);
  const persistedRaw = settingsStore.get(OPERATOR_SETTINGS_KEY);
  const persisted =
    persistedRaw === undefined ? undefined : parseOperatorSettings(JSON.parse(persistedRaw) as unknown);
  const mode = resolveGatedRuntimeMode({
    compileTimeMode,
    runtimeMode:
      env.POE2TC_RUNTIME_MODE ??
      (persisted?.firstRunCompleted === true ? persisted.selectedMode : undefined),
    packaged: options.packagedAppPath !== undefined,
  });
  const market = createFixtureMarketProvider(path.join(REPO_ROOT, "fixtures/market"));
  const replayCatalog = createFixtureReplayCatalog({
    fixturesDir: path.join(REPO_ROOT, "fixtures/replay"),
    scenariosDir: path.join(REPO_ROOT, "fixtures/scenarios"),
  });
  const logger = createRedactingLogger({ redactIdentifiers: true });
  logger.info("desktop-runtime-created", { mode, compileTimeMode });
  const traceSink =
    options.tracesPath !== undefined
      ? new FileTraceSink(options.tracesPath, { fsync: options.fsyncTraces === true })
      : undefined;
  return createOperatorRuntime({
    mode,
    compileTimeMode,
    emergencyStop: options.emergencyStop,
    settingsStore,
    replayCatalog,
    market,
    clipboard: options.clipboard,
    hotkeyRegistered: options.hotkeyRegistered ?? false,
    initialArming: {
      acknowledged: env.POE2TC_QA_ACKNOWLEDGED === "1",
    },
    traceSink,
  });
}
