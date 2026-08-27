import { createRequire } from "node:module";
import type { InputAction, InputResult, InputSink } from "@poe2tc/core";

export const NATIVE_UNAVAILABLE = "native-unavailable";

export class NativeUnavailableError extends Error {
  readonly code = NATIVE_UNAVAILABLE;

  constructor(detail: string) {
    super(`${NATIVE_UNAVAILABLE}: ${detail}`);
    this.name = "NativeUnavailableError";
  }
}

interface KoffiCType {
  readonly __brand?: string;
}

interface KoffiLib {
  func(declaration: string): (...args: never[]) => unknown;
}

interface KoffiModule {
  load(name: string): KoffiLib;
  struct(name: string, def: Record<string, string | KoffiCType>): KoffiCType;
  union(name: string, def: Record<string, string | KoffiCType>): KoffiCType;
  sizeof(type: KoffiCType | string): number;
}

export interface NativeLibraryLoader {
  platform: NodeJS.Platform;
  loadKoffi(): KoffiModule;
}

export function loadKoffiModule(load: () => KoffiModule = defaultLoadKoffi): KoffiModule {
  try {
    return load();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new NativeUnavailableError(`koffi could not load (${detail})`);
  }
}

function defaultLoadKoffi(): KoffiModule {
  const require = createRequire(import.meta.url);
  return require("koffi") as KoffiModule;
}

export function defaultNativeLoader(): NativeLibraryLoader {
  return {
    platform: process.platform,
    loadKoffi: () => loadKoffiModule(),
  };
}

type SendInputFn = (count: number, inputs: unknown, size: number) => number;
type SetCursorPosFn = (x: number, y: number) => number;

const INPUT_MOUSE = 0;
const INPUT_KEYBOARD = 1;
const KEYEVENTF_KEYUP = 0x0002;
const MOUSEEVENTF_LEFTDOWN = 0x0002;
const MOUSEEVENTF_LEFTUP = 0x0004;
const MOUSEEVENTF_RIGHTDOWN = 0x0008;
const MOUSEEVENTF_RIGHTUP = 0x0010;
const VK_BY_KEY: Record<string, number> = {
  enter: 0x0d,
  escape: 0x1b,
  tab: 0x09,
  space: 0x20,
  shift: 0x10,
  ctrl: 0x11,
  control: 0x11,
  alt: 0x12,
};

for (let code = 0; code < 26; code += 1) {
  VK_BY_KEY[String.fromCharCode(97 + code)] = 0x41 + code;
}
for (let digit = 0; digit <= 9; digit += 1) {
  VK_BY_KEY[String(digit)] = 0x30 + digit;
}
for (let fn = 1; fn <= 12; fn += 1) {
  VK_BY_KEY[`f${fn}`] = 0x6f + fn;
}

function virtualKey(key: string): number | undefined {
  if (key.length === 1 && key >= "A" && key <= "Z") {
    return key.charCodeAt(0);
  }
  return VK_BY_KEY[key.toLowerCase()];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export class NativeInputSink implements InputSink {
  readonly kind = "native" as const;
  readonly #sendInput: SendInputFn;
  readonly #setCursorPos: SetCursorPosFn;
  readonly #inputSize: number;
  #cancelled = false;

  constructor(loader: NativeLibraryLoader = defaultNativeLoader()) {
    const koffi = loadKoffiModule(() => loader.loadKoffi());
    if (loader.platform !== "win32") {
      throw new NativeUnavailableError(`SendInput requires win32 (got ${loader.platform})`);
    }
    try {
      const mouseInput = koffi.struct("MOUSEINPUT", {
        dx: "int32",
        dy: "int32",
        mouseData: "uint32",
        dwFlags: "uint32",
        time: "uint32",
        dwExtraInfo: "uintptr",
      });
      const keybdInput = koffi.struct("KEYBDINPUT", {
        wVk: "uint16",
        wScan: "uint16",
        dwFlags: "uint32",
        time: "uint32",
        dwExtraInfo: "uintptr",
      });
      const hardwareInput = koffi.struct("HARDWAREINPUT", {
        uMsg: "uint32",
        wParamL: "uint16",
        wParamH: "uint16",
      });
      const inputUnion = koffi.union("INPUT_U", {
        mi: mouseInput,
        ki: keybdInput,
        hi: hardwareInput,
      });
      koffi.struct("INPUT", {
        type: "uint32",
        u: inputUnion,
      });
      this.#inputSize = koffi.sizeof("INPUT");
      const user32 = koffi.load("user32.dll");
      this.#sendInput = user32.func(
        "uint32 __stdcall SendInput(uint32 cInputs, INPUT *pInputs, int cbSize)",
      ) as SendInputFn;
      this.#setCursorPos = user32.func("int32 __stdcall SetCursorPos(int32 X, int32 Y)") as SetCursorPosFn;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new NativeUnavailableError(`user32 SendInput bind failed (${detail})`);
    }
  }

  cancel(): void {
    this.#cancelled = true;
  }

  async execute(action: InputAction): Promise<InputResult> {
    const startedAtMs = Date.now();
    if (this.#cancelled) {
      return {
        accepted: false,
        executed: false,
        dryRun: false,
        blockedReason: "emergency-stop",
        startedAtMs,
        finishedAtMs: Date.now(),
      };
    }

    try {
      await this.#dispatch(action);
      return {
        accepted: true,
        executed: true,
        dryRun: false,
        startedAtMs,
        finishedAtMs: Date.now(),
      };
    } catch (err) {
      const blockedReason = err instanceof Error ? err.message : String(err);
      return {
        accepted: false,
        executed: false,
        dryRun: false,
        blockedReason,
        startedAtMs,
        finishedAtMs: Date.now(),
      };
    }
  }

  async #dispatch(action: InputAction): Promise<void> {
    switch (action.type) {
      case "noop":
        return;
      case "wait":
        if (action.durationMs > 0) {
          await delay(action.durationMs);
        }
        return;
      case "mouse-move":
        this.#move(action.x, action.y);
        return;
      case "mouse-click":
        this.#move(action.x, action.y);
        this.#mouseButton(action.button, true);
        if (action.holdMs !== undefined && action.holdMs > 0) {
          await delay(action.holdMs);
        }
        this.#mouseButton(action.button, false);
        return;
      case "mouse-drag":
        this.#move(action.from.x, action.from.y);
        this.#mouseButton(action.button, true);
        this.#move(action.to.x, action.to.y);
        this.#mouseButton(action.button, false);
        return;
      case "key-down":
        this.#key(action.key, false);
        return;
      case "key-up":
        this.#key(action.key, true);
        return;
      case "key-tap":
        this.#key(action.key, false);
        this.#key(action.key, true);
        return;
      default: {
        const neverAction: never = action;
        throw new Error(`unsupported-input-action: ${(neverAction as InputAction).type}`);
      }
    }
  }

  #move(x: number, y: number): void {
    const ok = this.#setCursorPos(Math.round(x), Math.round(y));
    if (!ok) {
      throw new Error("SetCursorPos failed");
    }
  }

  #mouseButton(button: "left" | "right", down: boolean): void {
    const flags =
      button === "left"
        ? down
          ? MOUSEEVENTF_LEFTDOWN
          : MOUSEEVENTF_LEFTUP
        : down
          ? MOUSEEVENTF_RIGHTDOWN
          : MOUSEEVENTF_RIGHTUP;
    this.#sendMouse(flags);
  }

  #sendMouse(dwFlags: number): void {
    const sent = this.#sendInput(
      1,
      {
        type: INPUT_MOUSE,
        u: {
          mi: {
            dx: 0,
            dy: 0,
            mouseData: 0,
            dwFlags,
            time: 0,
            dwExtraInfo: 0,
          },
        },
      },
      this.#inputSize,
    );
    if (sent !== 1) {
      throw new Error("SendInput mouse failed");
    }
  }

  #key(key: string, up: boolean): void {
    const vk = virtualKey(key);
    if (vk === undefined) {
      throw new Error(`unknown-key:${key}`);
    }
    const sent = this.#sendInput(
      1,
      {
        type: INPUT_KEYBOARD,
        u: {
          ki: {
            wVk: vk,
            wScan: 0,
            dwFlags: up ? KEYEVENTF_KEYUP : 0,
            time: 0,
            dwExtraInfo: 0,
          },
        },
      },
      this.#inputSize,
    );
    if (sent !== 1) {
      throw new Error("SendInput key failed");
    }
  }
}
