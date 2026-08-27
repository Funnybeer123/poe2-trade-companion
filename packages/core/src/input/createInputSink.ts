import type { RuntimeCapabilities } from "../capabilities/createCapabilities.js";
import { ForbiddenInputSink } from "./sinks/forbiddenInputSink.js";
import { NoopInputSink } from "./sinks/noopInputSink.js";
import type { InputSink } from "./types.js";

export function createInputSink(capabilities: RuntimeCapabilities): InputSink {
  if (!capabilities.canEmitNativeInput) {
    return new ForbiddenInputSink();
  }
  return new NoopInputSink();
}
