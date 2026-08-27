import { closeSync, fsyncSync, mkdirSync, openSync, writeSync } from "node:fs";
import path from "node:path";
import type { QaActionTrace, TraceSink } from "./types.js";

export interface FileTraceSinkOptions {
  /** When true, fsync after each append so a crash cannot lose the last line. */
  fsync?: boolean;
}

/**
 * Crash-safe append-only JSONL sink: open → append → optional fsync → close.
 * Never truncates an existing file.
 */
export class FileTraceSink implements TraceSink {
  readonly filePath: string;
  readonly #fsync: boolean;

  constructor(filePath: string, options: FileTraceSinkOptions = {}) {
    this.filePath = filePath;
    this.#fsync = options.fsync === true;
    mkdirSync(path.dirname(filePath), { recursive: true });
  }

  append(trace: QaActionTrace): void {
    const line = `${JSON.stringify(trace)}\n`;
    const fd = openSync(this.filePath, "a");
    try {
      writeSync(fd, line, undefined, "utf8");
      if (this.#fsync) {
        fsyncSync(fd);
      }
    } finally {
      closeSync(fd);
    }
  }
}
