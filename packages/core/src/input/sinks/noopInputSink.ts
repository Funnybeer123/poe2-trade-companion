import type { InputAction, InputResult, InputSink } from "../types.js";

export class NoopInputSink implements InputSink {
  readonly kind = "noop" as const;
  readonly recorded: InputAction[] = [];
  #cancelled = false;

  async execute(action: InputAction): Promise<InputResult> {
    const startedAtMs = Date.now();
    if (this.#cancelled) {
      return {
        accepted: false,
        executed: false,
        dryRun: true,
        blockedReason: "emergency-stop",
        startedAtMs,
        finishedAtMs: Date.now(),
      };
    }
    this.recorded.push(action);
    return {
      accepted: true,
      executed: false,
      dryRun: true,
      startedAtMs,
      finishedAtMs: Date.now(),
    };
  }

  cancel(): void {
    this.#cancelled = true;
  }
}
