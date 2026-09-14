import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import type { CalibrationProfile, ClientBox, GridMark } from "../core/calibrationProfile.js";

export interface BagMapContext {
  mapInstance: string;
  context: "map" | "town" | "hideout" | "unknown";
  loading: boolean;
  evidence: string;
  observedAt: number;
  processId?: number;
  areaId?: string;
  areaName?: string;
  enteredAt?: string;
  logOffset: number;
}

const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const LOG_LINE = /^(\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}) (\d+) [a-f\d]+ \[(DEBUG|INFO|WARN|ERROR|CRIT) Client (\d+)\] (.*)$/;
const contextFor = (area: string): BagMapContext["context"] => /^Map[A-Z][A-Za-z0-9_]*$/.test(area) ? "map"
  : /^Hideout[A-Z][A-Za-z0-9_]*$/.test(area) ? "hideout" : /^G\d+_town$/.test(area) ? "town" : "unknown";

/** A log proves an entered instance, not life, focus, inventory, cursor, or safe ground. */
export class BagMapLogParser {
  private processId?: number;
  private serverId?: string;
  private pending?: { areaId: string; source?: string; entry: string; generatedAt: string };
  private current?: { areaId: string; areaName: string; entry: string; enteredAt: string };
  private reason = "no-complete-instance-entry";
  private lastEvidence = "";
  private offset = 0;

  constructor(private readonly fileIdentity: string) {}

  invalidate(reason: string): void {
    this.serverId = undefined;
    this.pending = undefined;
    this.current = undefined;
    this.reason = reason;
  }

  accept(line: string, byteOffset: number): void {
    this.offset = byteOffset;
    const match = LOG_LINE.exec(line.replace(/\r$/, ""));
    if (!match) return;
    const [, timestamp, tick, level, pidText, message] = match;
    const pid = Number(pidText);
    if (this.processId !== pid) { this.invalidate("client-process-changed"); this.processId = pid; }
    // Match whole message bodies and their severity; player chat containing these words is not a signal.
    const transition = (level === "DEBUG" && message === "Got Instance Details from login server")
      || /^(?:Connecting to instance server at |Async connecting to [^ ]*\.login\.|Abnormal disconnect:|Disconnected from |Failed to connect to instance|\[SHUTDOWN\])/.test(message);
    if (transition) { this.invalidate("transition-or-disconnect"); this.lastEvidence = digest(line); return; }
    const server = level === "DEBUG" && /^Client-Safe Instance ID = (\d+)$/.exec(message);
    if (server) { this.invalidate("new-client-safe-instance"); this.serverId = server[1]; this.lastEvidence = digest(line); return; }
    const generated = level === "DEBUG" && /^Generating level \d+ area "([A-Za-z0-9_]+)" with seed (\d+)$/.exec(message);
    if (generated) {
      this.current = undefined;
      this.pending = this.serverId ? {
        areaId: generated[1], generatedAt: timestamp,
        entry: digest(`${this.fileIdentity}:${byteOffset}:${pid}:${timestamp}:${tick}:${this.serverId}:${generated[1]}:${generated[2]}`),
      } : undefined;
      this.serverId = undefined;
      this.reason = "waiting-for-matching-loading-completion";
      this.lastEvidence = digest(line);
      return;
    }
    if (level === "DEBUG" && /^(?:Generating level |Client-Safe Instance ID)/.test(message)) {
      this.invalidate("unrecognized-instance-transition"); this.lastEvidence = digest(line); return;
    }
    const source = level === "INFO" && /^\[SCENE\] Set Source \[([^\]\r\n]+)\]$/.exec(message);
    if (source) {
      if (this.current) this.invalidate("scene-changed");
      if (this.pending) this.pending.source = source[1] === "(null)" ? undefined : source[1];
      this.lastEvidence = digest(line);
      return;
    }
    const loaded = level === "INFO" && /^\[LOADING SCREEN\] \((.+)\) Duration = \d+(?:\.\d+)? seconds$/.exec(message);
    if (loaded) {
      if (this.pending && this.pending.source === loaded[1]) {
        this.current = { areaId: this.pending.areaId, areaName: loaded[1], entry: this.pending.entry, enteredAt: timestamp };
        this.pending = undefined;
        this.reason = contextFor(this.current.areaId) === "unknown" ? "unrecognized-area-id" : "matching-instance-entry-complete";
      } else this.invalidate("unmatched-loading-completion");
      this.lastEvidence = digest(line);
    }
  }

  snapshot(observedAt = Date.now(), expectedProcessId?: number): BagMapContext {
    const mismatched = expectedProcessId !== undefined && expectedProcessId !== this.processId;
    const context = !mismatched && this.current ? contextFor(this.current.areaId) : "unknown";
    return {
      mapInstance: context === "map" ? `client-log:${this.current!.entry}` : "",
      context, loading: mismatched || !this.current,
      evidence: `Client.txt:${this.offset}:${this.lastEvidence || "none"}:${mismatched ? "process-mismatch" : this.reason}`,
      observedAt, processId: this.processId, logOffset: this.offset,
      ...(!mismatched && this.current ? { areaId: this.current.areaId, areaName: this.current.areaName, enteredAt: this.current.enteredAt } : {}),
    };
  }
}

/** Bounded initial tail, incremental reads, and conservative invalidation on replacement/truncation. */
export function createBagMapContext(logPath: string, options: { maxReadBytes?: number; now?: () => number } = {}) {
  const maxRead = options.maxReadBytes ?? 4 * 1024 * 1024;
  if (!Number.isSafeInteger(maxRead) || maxRead < 1024 || maxRead > 16 * 1024 * 1024) throw new Error("Invalid Client.txt tail limit");
  const now = options.now ?? Date.now;
  let parser = new BagMapLogParser("unopened"), identity = "", prefix = Buffer.alloc(0), offset = 0;
  let tail = Buffer.alloc(0), tailOffset = 0, discardPartial = false, resetCount = 0;

  return {
    read(expectedProcessId?: number): BagMapContext {
      let fd: number | undefined;
      try {
        fd = openSync(logPath, "r");
        const stat = fstatSync(fd);
        if (!stat.isFile()) throw new Error("not-a-file");
        const nextIdentity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
        const nextPrefix = Buffer.alloc(Math.min(256, stat.size));
        readSync(fd, nextPrefix, 0, nextPrefix.length, 0);
        const replaced = identity !== nextIdentity || stat.size < offset || !nextPrefix.subarray(0, prefix.length).equals(prefix);
        if (replaced || stat.size - offset > maxRead) {
          const reset = identity ? `:reset:${++resetCount}:${stat.mtimeMs}` : "";
          identity = nextIdentity;
          parser = new BagMapLogParser(digest(nextIdentity + reset));
          offset = Math.max(0, stat.size - maxRead);
          tail = Buffer.alloc(0); tailOffset = offset; discardPartial = offset > 0;
        }
        prefix = nextPrefix;
        const readStart = offset, bytes = Buffer.alloc(stat.size - offset);
        let total = 0;
        while (total < bytes.length) {
          const length = readSync(fd, bytes, total, bytes.length - total, readStart + total);
          if (!length) throw new Error("log-short-read");
          total += length;
        }
        offset += total;
        if (fstatSync(fd).size < offset) throw new Error("log-truncated-during-read");
        let merged = Buffer.concat([tail, bytes]), start = tail.length ? tailOffset : readStart;
        if (discardPartial) {
          const newline = merged.indexOf(10);
          if (newline < 0) merged = Buffer.alloc(0);
          else { start += newline + 1; merged = merged.subarray(newline + 1); discardPartial = false; }
        }
        let consumed = 0, newline: number;
        while ((newline = merged.indexOf(10, consumed)) >= 0) {
          parser.accept(merged.subarray(consumed, newline).toString("utf8"), start + consumed);
          consumed = newline + 1;
        }
        tail = Buffer.from(merged.subarray(consumed)); tailOffset = start + consumed;
        if (tail.length > 64 * 1024) {
          tail = Buffer.alloc(0); discardPartial = true; parser.invalidate("oversized-log-line");
        }
        const result = parser.snapshot(now(), expectedProcessId);
        // An unfinished line might be a transition; do not trust the previous instance until it completes.
        return tail.length || discardPartial ? { ...result, context: "unknown", mapInstance: "", loading: true, evidence: `${result.evidence}:partial-log-line` } : result;
      } catch {
        parser.invalidate("log-unavailable-or-changed"); identity = ""; prefix = Buffer.alloc(0); offset = 0; tail = Buffer.alloc(0);
        return parser.snapshot(now(), expectedProcessId);
      } finally { if (fd !== undefined) closeSync(fd); }
    },
  };
}

/** Calibration is valid only for the exact current client size and a complete 12 by 5 grid. */
export function validateBagCalibration(profile: CalibrationProfile, client: ClientBox): { grid: GridMark; hash: string } {
  const grid = profile.bagGrid;
  if (!grid || grid.cols !== 12 || grid.rows !== 5 || profile.version !== 1
    || profile.client.width !== client.w || profile.client.height !== client.h
    || ![client.x, client.y, client.w, client.h, grid.x, grid.y, grid.w, grid.h].every(Number.isFinite)
    || client.w <= 0 || client.h <= 0 || grid.x < 0 || grid.y < 0 || grid.w <= 0 || grid.h <= 0
    || grid.x + grid.w > client.w || grid.y + grid.h > client.h) throw new Error("Bag calibration does not match the current client rectangle");
  return { grid: structuredClone(grid), hash: digest(JSON.stringify({ client, profile })) };
}
