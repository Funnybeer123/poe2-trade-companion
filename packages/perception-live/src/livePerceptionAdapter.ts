import {
  analyzeFailureFrame,
  type PerceptionAdapter,
  type PerceptionFrame,
  type PerceptionFrameInput,
} from "@poe2tc/core";
import type { ForegroundProcessInfo } from "./win32Process.js";

export type ForegroundProcessQuery = () => ForegroundProcessInfo;

/**
 * Live perception adapter: attaches Win32 process metadata to each frame.
 * Pixel detectors (template/OCR) land in later phases; analyze errors become
 * unknown UI with confidence 0.
 */
export class LivePerceptionAdapter implements PerceptionAdapter {
  readonly #queryProcess: ForegroundProcessQuery;

  constructor(queryProcess: ForegroundProcessQuery) {
    this.#queryProcess = queryProcess;
  }

  async analyze(frame: PerceptionFrameInput): Promise<PerceptionFrame> {
    try {
      const process = this.#queryProcess();
      return {
        tickId: frame.tickId,
        capturedAtMs: frame.capturedAtMs,
        evidenceId: `live:${String(frame.tickId)}`,
        process: {
          value: {
            pid: process.pid,
            name: process.name,
            title: process.title,
            allowlisted: false,
          },
          confidence: process.name !== undefined || process.title !== undefined ? 0.9 : 0,
          observedAtMs: frame.capturedAtMs,
          freshness: "fresh",
        },
        ui: {
          value: { kind: "unknown", details: "live-ui-deferred" },
          confidence: 0.2,
          observedAtMs: frame.capturedAtMs,
          freshness: "fresh",
        },
      };
    } catch (error) {
      return analyzeFailureFrame(frame, error);
    }
  }
}

export function createLivePerceptionAdapter(
  queryProcess: ForegroundProcessQuery,
): LivePerceptionAdapter {
  return new LivePerceptionAdapter(queryProcess);
}
