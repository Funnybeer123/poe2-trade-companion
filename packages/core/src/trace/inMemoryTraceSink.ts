import type { QaActionTrace, TraceSink } from "./types.js";

export class InMemoryTraceSink implements TraceSink {
  readonly traces: QaActionTrace[] = [];

  append(trace: QaActionTrace): void {
    this.traces.push(trace);
  }
}
