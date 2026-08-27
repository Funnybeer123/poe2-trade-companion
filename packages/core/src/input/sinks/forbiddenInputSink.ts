import type { InputAction, InputResult, InputSink } from "../types.js";

export const PUBLIC_COMPANION_FORBIDDEN_REASON = "public-companion-forbids-native-input";

export class ForbiddenInputSink implements InputSink {
  readonly kind = "forbidden" as const;

  async execute(action: InputAction): Promise<InputResult> {
    void action;
    const startedAtMs = Date.now();
    return {
      accepted: false,
      executed: false,
      dryRun: false,
      blockedReason: PUBLIC_COMPANION_FORBIDDEN_REASON,
      startedAtMs,
      finishedAtMs: Date.now(),
    };
  }

  cancel(): void {
    // Forbidden sink never emits input.
  }
}
