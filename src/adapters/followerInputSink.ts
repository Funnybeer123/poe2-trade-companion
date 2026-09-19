import type { InputSink } from "../core/inputSink.js";
import type { InputAction } from "../core/types.js";
import type { WinHostTransport } from "./winHostInputSink.js";

/** The capture a click was decided from. The native host refuses the click if any of it no longer holds. */
export interface FollowerFrameGuard { hwnd: string; viewWidth: number; viewHeight: number; capturedAtQpcMs: number }

/** Marks a click as a loot pickup: the input worker then allows the world view instead of the central movement disc. */
export const LOOT_CLICK = "loot";
/** One guarded left-click per action: no queue, no focus changes, no keys, nothing held after it returns. */
export class FollowerInputSink implements InputSink {
  /** Native timings of the most recent accepted click: host time and capture-start to click-complete. */
  lastInput?: { inputMs: number; captureToInputMs: number };
  constructor(private readonly host: WinHostTransport, private readonly guard: () => FollowerFrameGuard | undefined, private readonly maxAgeMs = 120) {}
  async emit(action: InputAction): Promise<void> {
    const frame = this.guard();
    if (!frame) throw new Error("Follow stopped or capture stale");
    if (!frame.hwnd || !Number.isFinite(frame.capturedAtQpcMs) || !Number.isInteger(frame.viewWidth) || !Number.isInteger(frame.viewHeight)) throw new Error("Capture stale: incomplete capture guard");
    if (action.text !== undefined && action.text !== LOOT_CLICK) throw new Error("Invalid follow action");
    if (action.kind !== "click" || (action.button ?? "left") !== "left" || action.modifier || !Number.isInteger(action.x) || !Number.isInteger(action.y)) throw new Error("Invalid follow action");
    const result = await this.host.send({ op: "moveclick", x: action.x, y: action.y, expectedHwnd: frame.hwnd, viewWidth: frame.viewWidth, viewHeight: frame.viewHeight, capturedAtQpcMs: frame.capturedAtQpcMs, maxAgeMs: this.maxAgeMs, area: action.text === LOOT_CLICK ? "loot" : "move" });
    if (!result.ok) throw new Error(String(result.error ?? "Follow input failed"));
    this.lastInput = { inputMs: Number(result.inputMs) || 0, captureToInputMs: Number(result.captureToInputMs) || 0 };
  }
  clear(): void { /* One action at a time; the worker releases the button itself and is terminated on stop. */ }
}
