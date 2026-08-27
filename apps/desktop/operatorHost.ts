import {
  createFixtureMarketProvider,
  createFixtureReplayCatalog,
  createOperatorRuntime,
  EmergencyStop,
  type OperatorRuntime,
  type RuntimeMode,
} from "@poe2tc/core";
import { applyMigrations, openSqliteDatabase, SqliteSettingsStore } from "@poe2tc/persistence-sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(desktopDir, "../..");

export function resolveRuntimeMode(env: NodeJS.ProcessEnv = process.env): RuntimeMode {
  return env.POE2TC_RUNTIME_MODE === "authorized-qa" ? "authorized-qa" : "public-companion";
}

export function createDesktopRuntime(options: {
  emergencyStop?: EmergencyStop;
  dbPath?: string;
  clipboard?: { readText(): string };
  hotkeyRegistered?: boolean;
  env?: NodeJS.ProcessEnv;
}): OperatorRuntime {
  const env = options.env ?? process.env;
  const db = openSqliteDatabase(options.dbPath ?? env.POE2TC_DB_PATH ?? ":memory:");
  applyMigrations(db, path.join(REPO_ROOT, "migrations"));
  const settingsStore = new SqliteSettingsStore(db);
  const market = createFixtureMarketProvider(path.join(REPO_ROOT, "fixtures/market"));
  const replayCatalog = createFixtureReplayCatalog({
    fixturesDir: path.join(REPO_ROOT, "fixtures/replay"),
    scenariosDir: path.join(REPO_ROOT, "fixtures/scenarios"),
  });
  return createOperatorRuntime({
    mode: resolveRuntimeMode(env),
    emergencyStop: options.emergencyStop,
    settingsStore,
    replayCatalog,
    market,
    clipboard: options.clipboard,
    hotkeyRegistered: options.hotkeyRegistered ?? false,
    initialArming: {
      acknowledged: env.POE2TC_QA_ACKNOWLEDGED === "1",
    },
  });
}
