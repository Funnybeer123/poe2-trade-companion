import type { InputSink } from "../core/inputSink.js";
import type { InputAction } from "../core/types.js";
import type { WinHostTransport } from "./winHostInputSink.js";

/** No focus changes, no queued input, and an atomic down/up at the OS boundary. */
export class CombatInputSink implements InputSink {
  constructor(private host: WinHostTransport, private guard: () => string | undefined) {}
  async emit(action: InputAction): Promise<void> {
    const hwnd = this.guard();
    if (!hwnd) throw new Error("Combat input stopped or capture stale");
    if (action.kind !== "key" || !/^[A-Z0-9]$/.test(action.key ?? "")) throw new Error("Invalid combat action");
    const result = await this.host.send({ op: "tap", key: action.key, expectedHwnd: hwnd });
    if (!result.ok) throw new Error(String(result.error ?? "Combat input failed"));
  }
  clear(): void { /* One action at a time; worker is terminated on stop. */ }
}
