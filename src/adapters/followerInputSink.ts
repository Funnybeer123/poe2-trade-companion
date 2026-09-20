import type { InputSink } from "../core/inputSink.js";
import type { InputAction } from "../core/types.js";
import type { WinHostTransport } from "./winHostInputSink.js";

/** The capture a click was decided from. The native host refuses the click if any of it no longer holds. */
export interface FollowerFrameGuard { hwnd: string; viewWidth: number; viewHeight: number; capturedAtQpcMs: number }

/** Marks a click as a loot pickup: the input worker then allows the world view instead of the central movement disc. */
export const LOOT_CLICK = "loot";
/** Marks a click as the party frame's travel button: the input worker then allows that top-left corner and nothing else. */
export const PARTY_CLICK = "party";
/** Marks a click as the OK of the teleport confirmation: the input worker then allows that button and nothing else — never CANCEL. */
export const CONFIRM_CLICK = "confirm";
/** The whole set of click markers, and the view area each one buys. A Map, so no inherited property name ("toString") can pass for a marker. */
const AREAS = new Map([[LOOT_CLICK, "loot"], [PARTY_CLICK, "party"], [CONFIRM_CLICK, "confirm"]]);
/** Marks a key action as starting the sprint hold. Renewing and releasing it are not new input and have their own methods. */
export const SPRINT_HOLD = "hold";
/** Marks a key action as one Escape: pressed and released in the same request, so nothing is left held and the sprint hold is untouched. */
export const ESCAPE_TAP = "tap";
/** The whole set of key actions, and the marker each key must carry. A Map, so no inherited property name passes for a key, and so no key accepts another's marker. */
const KEYS = new Map([["space", SPRINT_HOLD], ["escape", ESCAPE_TAP]]);
/** One guarded left-click per action: no queue, no focus changes, no keys, nothing held after it returns. */
export class FollowerInputSink implements InputSink {
  /** Native timings of the most recent accepted click: host time and capture-start to click-complete. */
  lastInput?: { inputMs: number; captureToInputMs: number };
  constructor(private readonly host: WinHostTransport, private readonly guard: () => FollowerFrameGuard | undefined, private readonly maxAgeMs = 120) {}
  async emit(action: InputAction): Promise<void> {
    const frame = this.guard();
    if (!frame) throw new Error("Follow stopped or capture stale");
    if (!frame.hwnd || !Number.isFinite(frame.capturedAtQpcMs) || !Number.isInteger(frame.viewWidth) || !Number.isInteger(frame.viewHeight)) throw new Error("Capture stale: incomplete capture guard");
    if (action.kind === "key") {
      const marker = KEYS.get(action.key ?? "");
      if (!marker || action.text !== marker || action.modifier) throw new Error("Invalid follow action");
      if (action.key === "escape") await this.tapEscape(frame);
      else await this.holdSprint(frame, true);
      return;
    }
    const area = action.text === undefined ? "move" : AREAS.get(action.text);
    if (!area) throw new Error("Invalid follow action");
    if (action.kind !== "click" || (action.button ?? "left") !== "left" || action.modifier || !Number.isInteger(action.x) || !Number.isInteger(action.y)) throw new Error("Invalid follow action");
    const result = await this.host.send({ op: "moveclick", x: action.x, y: action.y, expectedHwnd: frame.hwnd, viewWidth: frame.viewWidth, viewHeight: frame.viewHeight, capturedAtQpcMs: frame.capturedAtQpcMs, maxAgeMs: this.maxAgeMs, area });
    if (!result.ok) throw new Error(String(result.error ?? "Follow input failed"));
    this.lastInput = { inputMs: Number(result.inputMs) || 0, captureToInputMs: Number(result.captureToInputMs) || 0 };
  }
  /** One Escape, down and up inside the worker's own op: no dead-man's switch, nothing to renew, and no click timing to record. */
  private async tapEscape(frame: FollowerFrameGuard): Promise<void> {
    const result = await this.host.send({ op: "key", key: "escape", expectedHwnd: frame.hwnd, viewWidth: frame.viewWidth, viewHeight: frame.viewHeight, capturedAtQpcMs: frame.capturedAtQpcMs, maxAgeMs: this.maxAgeMs });
    if (!result.ok) throw new Error(String(result.error ?? "Escape input failed"));
  }
  private async holdSprint(frame: FollowerFrameGuard, start: boolean): Promise<void> {
    const result = await this.host.send({ op: "sprint", hold: true, start, expectedHwnd: frame.hwnd, viewWidth: frame.viewWidth, viewHeight: frame.viewHeight, capturedAtQpcMs: frame.capturedAtQpcMs, maxAgeMs: this.maxAgeMs });
    if (!result.ok) throw new Error(String(result.error ?? "Sprint input failed"));
  }
  /** Keeps an already started sprint alive for another few hundred milliseconds. The worker re-checks every guard and lets go if any fails. It can never press the key: a lapsed sprint fails here and must be started again through the controller. */
  async renewSprint(): Promise<void> {
    const frame = this.guard();
    if (!frame) { await this.releaseSprint(); throw new Error("Follow stopped or capture stale"); }
    await this.holdSprint(frame, false);
  }
  /** Letting go is never refused: not by the guard, the kill switch, or dry-run. */
  async releaseSprint(): Promise<void> { await this.host.send({ op: "sprint", hold: false }).catch(() => undefined); }
  clear(): void { /* One action at a time; the worker releases the button itself and is terminated on stop. */ }
}
