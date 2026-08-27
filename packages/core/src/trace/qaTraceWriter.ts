import type { QaActionTrace, RedactionSettings, TraceSink } from "./types.js";
import { redactQaActionTrace } from "./redact.js";

export interface QaTraceWriterOptions {
  redactIdentifiers?: boolean;
  identifiers?: string[];
}

export class QaTraceWriter {
  readonly #sink: TraceSink;
  readonly #settings: RedactionSettings;

  constructor(sink: TraceSink, options: QaTraceWriterOptions = {}) {
    this.#sink = sink;
    this.#settings = {
      redactIdentifiers: options.redactIdentifiers ?? false,
      identifiers: options.identifiers,
    };
  }

  write(trace: QaActionTrace): QaActionTrace {
    const redacted = redactQaActionTrace(trace, this.#settings);
    this.#sink.append(redacted);
    return redacted;
  }
}
