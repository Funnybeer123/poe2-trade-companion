/**
 * File persistence for the auto-flask guard config the daemon polls and the
 * app's Hotkeys tool edits. Pure rules live in src/shared/flaskGuard.ts.
 */

import path from "node:path";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import {
  defaultFlaskGuardConfig,
  normalizeFlaskGuardConfig,
  type FlaskGuardConfig,
  type FlaskGuardValidation,
} from "../shared/flaskGuard.js";

export function flaskGuardConfigPath(root: string): string {
  return path.join(root, "artifacts", "flask-guard.json");
}

export interface LoadedFlaskGuardConfig extends FlaskGuardValidation {
  source: "file" | "defaults";
  /** File mtime (ms) so pollers can skip unchanged reads; 0 for defaults. */
  mtimeMs: number;
}

export function loadFlaskGuardConfig(root: string): LoadedFlaskGuardConfig {
  const file = flaskGuardConfigPath(root);
  if (!existsSync(file)) {
    return { config: defaultFlaskGuardConfig(), issues: [], source: "defaults", mtimeMs: 0 };
  }
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { config?: unknown };
    const mtimeMs = statSync(file).mtimeMs;
    return { ...normalizeFlaskGuardConfig(parsed.config ?? parsed), source: "file", mtimeMs };
  } catch (error) {
    return {
      config: defaultFlaskGuardConfig(),
      issues: [`flask-guard.json unreadable (${String(error)}) — using defaults`],
      source: "defaults",
      mtimeMs: 0,
    };
  }
}

/** Normalizes, writes, and returns what was actually saved. */
export function saveFlaskGuardConfig(root: string, raw: unknown): FlaskGuardValidation {
  const normalized = normalizeFlaskGuardConfig(raw);
  const file = flaskGuardConfigPath(root);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({ savedAt: new Date().toISOString(), config: normalized.config }, null, 2),
  );
  return normalized;
}

export type { FlaskGuardConfig };
