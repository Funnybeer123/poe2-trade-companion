/**
 * Feature module "hotkeys": provides the HotkeyService (ctx service
 * "hotkeys") and the `hotkeys:*` channels the Tools → Hotkeys section uses.
 *
 * Electron's globalShortcut is resolved lazily inside register() so the
 * module file itself stays importable (and testable) under plain Node; tests
 * inject a fake through `createHotkeysModule({ globalShortcut })`.
 */
import { loadVoiceTransferConfig } from "../../voiceTransferSettings.js";
import {
  createHotkeyService,
  hotkeyBindingsFilePath,
  type GlobalShortcutLike,
  type HotkeyService,
  type HotkeyServiceOptions,
} from "../../hotkeyService.js";
import type { FeatureModule } from "../types.js";

declare module "../types.js" {
  interface FeatureServiceMap {
    hotkeys: HotkeyService;
  }
}

export interface HotkeysModuleDeps {
  /** Defaults to Electron's globalShortcut. */
  globalShortcut?: GlobalShortcutLike;
  fs?: HotkeyServiceOptions["fs"];
  /** Extra reserved accelerators; defaults to the voice hotkey from voice-transfer.json. */
  reserved?: HotkeyServiceOptions["reserved"];
}

async function electronGlobalShortcut(): Promise<GlobalShortcutLike> {
  const { globalShortcut } = await import("electron");
  return globalShortcut;
}

/**
 * The voice hotkey lives in its own file (`voice-transfer.json` under
 * userData) and is registered by src/main/index.ts; re-read per validation
 * so a change in Tools → Voice is respected without a restart.
 */
function voiceHotkeyReserved(userDataDir: string): HotkeyServiceOptions["reserved"] {
  return () => {
    try {
      const config = loadVoiceTransferConfig(userDataDir);
      return config.hotkey ? [{ accelerator: config.hotkey, label: "the voice hotkey" }] : [];
    } catch {
      return [];
    }
  };
}

export function createHotkeysModule(deps: HotkeysModuleDeps = {}): FeatureModule {
  return {
    id: "hotkeys",
    async register(ctx) {
      const globalShortcut = deps.globalShortcut ?? (await electronGlobalShortcut());
      const service = createHotkeyService({
        globalShortcut,
        file: hotkeyBindingsFilePath(ctx.userDataDir),
        fs: deps.fs,
        reserved: deps.reserved ?? voiceHotkeyReserved(ctx.userDataDir),
        onChange: (bindings) => ctx.emit("hotkeys:changed", bindings),
        log: (level, message, detail) => ctx.log({ feature: "hotkeys", level, message, detail }),
      });
      ctx.provide("hotkeys", service);
      ctx.handle("hotkeys:list", () => service.list());
      ctx.handle("hotkeys:rebind", (id: string, accelerator: string | null) =>
        service.rebind(String(id), accelerator === null || accelerator === undefined ? null : String(accelerator)),
      );
      ctx.handle("hotkeys:validate", (accelerator: string, forId?: string) =>
        service.validate(String(accelerator ?? ""), typeof forId === "string" ? forId : undefined),
      );
      ctx.handle("hotkeys:trigger", (id: string) => service.trigger(String(id)));
      ctx.handle("hotkeys:reset", (id?: string) => service.reset(typeof id === "string" && id ? id : undefined));
      return { dispose: () => service.dispose() };
    },
  };
}

export const hotkeysModule: FeatureModule = createHotkeysModule();
