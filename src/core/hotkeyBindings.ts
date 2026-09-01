/**
 * File persistence for the numpad hotkey bindings the action daemon
 * dispatches on and the app's Hotkeys tool edits. The pure catalog and
 * normalization rules live in src/shared/hotkeyActions.ts.
 */

import path from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  defaultHotkeyBindings,
  normalizeHotkeyBindings,
  type BindingsValidation,
  type HotkeyBindings,
} from "../shared/hotkeyActions.js";

export function hotkeyBindingsPath(root: string): string {
  return path.join(root, "artifacts", "hotkey-bindings.json");
}

export interface LoadedHotkeyBindings extends BindingsValidation {
  source: "file" | "defaults";
}

export function loadHotkeyBindings(root: string): LoadedHotkeyBindings {
  const file = hotkeyBindingsPath(root);
  if (!existsSync(file)) {
    return { bindings: defaultHotkeyBindings(), issues: [], source: "defaults" };
  }
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { bindings?: unknown };
    return { ...normalizeHotkeyBindings(parsed.bindings ?? parsed), source: "file" };
  } catch (error) {
    return {
      bindings: defaultHotkeyBindings(),
      issues: [`hotkey-bindings.json unreadable (${String(error)}) — using defaults`],
      source: "defaults",
    };
  }
}

/** Normalizes, writes, and returns what was actually saved. */
export function saveHotkeyBindings(root: string, raw: unknown): BindingsValidation {
  const normalized = normalizeHotkeyBindings(raw);
  const file = hotkeyBindingsPath(root);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({ savedAt: new Date().toISOString(), bindings: normalized.bindings }, null, 2),
  );
  return normalized;
}

export type { HotkeyBindings };
