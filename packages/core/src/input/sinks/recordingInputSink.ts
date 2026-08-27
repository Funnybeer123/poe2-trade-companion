import type { InputAction, InputResult, InputSink } from "../types.js";

export class RecordingInputSink implements InputSink {
  readonly kind = "recording" as const;
  readonly actions: InputAction[] = [];

  constructor(private readonly inner: InputSink) {}

  async execute(action: InputAction): Promise<InputResult> {
    this.actions.push(action);
    return this.inner.execute(action);
  }

  cancel(): void {
    this.inner.cancel();
  }
}
