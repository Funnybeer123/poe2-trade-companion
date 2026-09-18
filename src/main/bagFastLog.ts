import { createHash } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, writeSync } from "node:fs";
import path from "node:path";
import type { FastLogEntry } from "../core/bagFastRun.js";

/** Small hash-chained action log for the fast bag workflow. Each record is a few
 * hundred bytes and is flushed before the caller issues input, so intent stays
 * durable without re-serializing the whole session on every action. A new run
 * always uses a new file; an existing log is evidence and is never appended to. */
export function openBagFastLog(file: string) {
  mkdirSync(path.dirname(file), { recursive: true });
  const fd = openSync(file, "wx");
  let sequence = 0, previous = "", closed = false;
  return {
    record(entry: FastLogEntry): void {
      if (closed) throw new Error("Bag action log is closed.");
      const body = { sequence, previous, at: new Date().toISOString(), ...entry };
      const hash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
      const bytes = Buffer.from(JSON.stringify({ ...body, hash }) + "\n");
      let written = 0;
      while (written < bytes.length) {
        const n = writeSync(fd, bytes, written, bytes.length - written);
        if (n <= 0) throw new Error("Bag action log write did not progress.");
        written += n;
      }
      fsyncSync(fd); sequence++; previous = hash;
    },
    close(): void { if (!closed) { closed = true; closeSync(fd); } },
  };
}
