import type { InputAction } from "./types.js";

export interface InputBatchOptions {
  ctrl?: boolean;
  shift?: boolean;
}

export interface InputSink {
  emit(action: InputAction): Promise<void>;
  emitBatch?(actions: InputAction[], options?: InputBatchOptions): Promise<void>;
  clear(): void;
}

export class FakeInputSink implements InputSink {
  readonly emitted: InputAction[] = [];

  async emit(action: InputAction): Promise<void> {
    this.emitted.push(action);
  }

  async emitBatch(actions: InputAction[]): Promise<void> {
    this.emitted.push(...actions);
  }

  clear(): void {
    this.emitted.length = 0;
  }
}

export class NativeInputSink implements InputSink {
  constructor(private readonly enabled: boolean) {}

  async emit(action: InputAction): Promise<void> {
    if (!this.enabled) {
      throw new Error("native-input-disabled");
    }
    // Live SendInput is only armed in authorized-qa packaged builds with explicit enablement.
    // Replay and tests must use FakeInputSink.
    void action;
  }

  async emitBatch(actions: InputAction[]): Promise<void> {
    for (const action of actions) await this.emit(action);
  }

  clear(): void {
    // no queue in this thin adapter
  }
}
