import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

export const MIGRATIONS_DIR = join(REPO_ROOT, "migrations");

export function scenarioFixturePath(id: string): string {
  return join(REPO_ROOT, "fixtures/scenarios", `${id}.json`);
}

export function replayManifestPath(id: string): string {
  return join(REPO_ROOT, "fixtures/replay", id, "manifest.json");
}

export function itemFixturePath(name: string): string {
  return join(REPO_ROOT, "fixtures/items", name);
}

export function marketFixtureDir(): string {
  return join(REPO_ROOT, "fixtures/market");
}

export function marketFixturePath(name: string): string {
  return join(REPO_ROOT, "fixtures/market", name);
}
