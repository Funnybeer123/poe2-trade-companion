/**
 * Configurable global hotkeys (package "hotkeys", brief D3).
 *
 * Features contribute actions in the main process; the user binds Electron
 * accelerators to them from Tools → Hotkeys. These are the shapes the
 * renderer sees; the pure accelerator rules live in src/core/hotkeyRegistry.ts.
 */
import type { FeatureCall } from "./features.js";

export interface HotkeyActionInfo {
  id: string;
  label: string;
  detail?: string;
  /** Section in the Hotkeys UI ("Overlay", "Commands", …). */
  group: string;
  defaultAccelerator: string | null;
}

export interface HotkeyBindingView extends HotkeyActionInfo {
  accelerator: string | null;
  registered: boolean;
  /** Why the accelerator is not active (invalid, reserved, taken, OS refused). */
  error?: string;
}

export interface HotkeyValidation {
  ok: boolean;
  reason?: string;
  /** The action id (or reserved-key label) the accelerator collides with. */
  conflictsWith?: string;
}

export interface HotkeysContract {
  "hotkeys:list": FeatureCall<[], HotkeyBindingView[]>;
  "hotkeys:rebind": FeatureCall<[id: string, accelerator: string | null], HotkeyBindingView[]>;
  "hotkeys:validate": FeatureCall<[accelerator: string, forId?: string], HotkeyValidation>;
  /** Run an action from the desktop UI. */
  "hotkeys:trigger": FeatureCall<[id: string], boolean>;
  /** Back to the default accelerator (one action, or all of them). */
  "hotkeys:reset": FeatureCall<[id?: string], HotkeyBindingView[]>;
}

export interface HotkeysEvents {
  "hotkeys:changed": HotkeyBindingView[];
}

/** Shape of %APPDATA%/poe2-trade-companion/overlay-hotkeys.json. */
export interface HotkeyBindingsFile {
  version: 1;
  /** Only ids the user changed; absent = the action's default. `null` = unbound. */
  bindings: Record<string, string | null>;
}
