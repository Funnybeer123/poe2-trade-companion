/**
 * Feature module "clientLog": tails Path of Exile 2's Client.txt and turns
 * it into typed events for the other features (trade offers, session,
 * campaign guide) and for the renderer (`client-log:event`).
 *
 * The file is huge (hundreds of MB), so the tailer never reads it whole:
 * on start it backfills the last BACKFILL_BYTES into the ring buffer
 * WITHOUT emitting live events (so the character and area are known at
 * launch without replaying old trades), then polls `fs.stat` every 500 ms
 * and reads only the appended bytes, carrying a partial trailing line as
 * raw bytes so multibyte characters survive chunk boundaries. A size that
 * shrank means the game truncated/rotated the log: restart from 0 (bounded
 * by the same backfill window).
 *
 * Nothing here writes log contents anywhere; the ring buffer stays in
 * memory (≤ RING_CAPACITY events).
 */
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { areaInfo } from "../../../core/areaCatalog.js";
import { parseClientLogLine, type ClientLogEvent } from "../../../core/clientLog.js";
import { parseGameSettingsIni, type GameSettings } from "../../../core/gameSettingsFile.js";
import type {
  ClientLogSettings,
  ClientLogSource,
  ClientLogStatus,
} from "../../../shared/clientLog.js";
import type { FeatureContext, FeatureModule } from "../types.js";
import {
  defaultLocatorEnv,
  gameSettingsCandidates,
  locateClientLog,
  type LocatorEnv,
  type LocatorFs,
} from "./locate.js";

declare module "../types.js" {
  interface FeatureServiceMap {
    clientLog: ClientLogService;
  }
}

export type ClientLogEventKind = ClientLogEvent["kind"];
type EventOf<K extends ClientLogEventKind | "*"> = K extends "*"
  ? ClientLogEvent
  : Extract<ClientLogEvent, { kind: K }>;

export interface ClientLogService {
  status(): ClientLogStatus;
  on<K extends ClientLogEventKind | "*">(kind: K, callback: (event: EventOf<K>) => void): () => void;
  /** Ring buffer, newest last, ≤ RING_CAPACITY. */
  recent(kind?: ClientLogEventKind, limit?: number): ClientLogEvent[];
  /** User override (persisted in settings "client-log"); undefined = auto-locate. */
  setFile(file: string | undefined): ClientLogStatus;
  /** Re-read the last N bytes into `recent` without emitting; resolves to the event count. */
  replayTail(bytes?: number): Promise<number>;
  /**
   * Re-read poe2_production_Config.ini (both Documents locations, newest
   * wins) and refresh `status().gameSettings`. Call it after the user has
   * changed the game's resolution or chat key without restarting the app.
   */
  reloadGameSettings(): GameSettings | undefined;
}

export const RING_CAPACITY = 5_000;
export const BACKFILL_BYTES = 2 * 1024 * 1024;
export const POLL_MS = 500;
/** Most bytes one poll reads; the remainder waits for the next tick. */
const MAX_READ_PER_POLL = 4 * 1024 * 1024;
/** Polls between relocation attempts while no file is found (10 s at 500 ms). */
const RELOCATE_EVERY_POLLS = 20;
const NEWLINE = 0x0a;

export interface ClientLogFs extends LocatorFs {
  stat(file: string): { size: number; mtimeMs: number } | undefined;
  /** Bytes [start, end) of the file; shorter when the file is shorter. */
  readRange(file: string, start: number, end: number): Buffer;
}

export interface OpenDialogLike {
  showOpenDialog(options: {
    title?: string;
    defaultPath?: string;
    filters?: Array<{ name: string; extensions: string[] }>;
    properties?: string[];
  }): Promise<{ canceled: boolean; filePaths: string[] }>;
}

export interface ClientLogModuleOptions {
  fs?: ClientLogFs;
  env?: LocatorEnv;
  /** %USERPROFILE%; the game config lives under its Documents. */
  userProfile?: string;
  pollMs?: number;
  backfillBytes?: number;
  /** Injected for tests; defaults to Electron's dialog (imported lazily). */
  dialog?: OpenDialogLike;
  /** Test seam: do not arm the poll timer (call `service.poll()` yourself). */
  manualPolls?: boolean;
}

export const realClientLogFs: ClientLogFs = {
  exists: (file) => existsSync(file),
  readText: (file) => {
    try {
      return readFileSync(file, "utf8");
    } catch {
      return undefined;
    }
  },
  stat: (file) => {
    try {
      const stat = statSync(file);
      return { size: stat.size, mtimeMs: stat.mtimeMs };
    } catch {
      return undefined;
    }
  },
  readRange: (file, start, end) => {
    const fd = openSync(file, "r");
    try {
      const buffer = Buffer.alloc(Math.max(0, end - start));
      let read = 0;
      while (read < buffer.length) {
        const n = readSync(fd, buffer, read, buffer.length - read, start + read);
        if (n === 0) break;
        read += n;
      }
      return read === buffer.length ? buffer : buffer.subarray(0, read);
    } finally {
      closeSync(fd);
    }
  },
};

/** Sanitizer for the "client-log" settings namespace. */
export function normalizeClientLogSettings(raw: unknown): ClientLogSettings {
  const source = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const file = typeof source.file === "string" ? source.file.trim() : "";
  return { ...(file ? { file } : {}), allowInject: source.allowInject === true };
}

export interface ClientLogServiceHooks {
  settings: { get(): ClientLogSettings; set(patch: Partial<ClientLogSettings>): ClientLogSettings };
  /** Fan-out to app windows (`client-log:event`, `client-log:status`). */
  emit(channel: "client-log:event" | "client-log:status", payload: unknown): void;
  log(level: "info" | "warn" | "error", message: string, detail?: unknown): void;
}

interface TailState {
  file: string;
  source: ClientLogSource;
  offset: number;
  carry: Buffer;
}

export class ClientLogTailer implements ClientLogService {
  private readonly fs: ClientLogFs;
  private readonly env: LocatorEnv;
  private readonly backfillBytes: number;
  private readonly ring: ClientLogEvent[] = [];
  private readonly listeners = new Map<string, Set<(event: ClientLogEvent) => void>>();
  private tail: TailState | undefined;
  private source: ClientLogSource = "none";
  private sizeBytes: number | undefined;
  private lastLineAt: string | undefined;
  private error: string | undefined;
  private character: ClientLogStatus["character"];
  private area: ClientLogStatus["area"];
  private gameSettings: GameSettings | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private pollsSinceLocate = 0;
  private disposed = false;

  constructor(
    private readonly options: ClientLogModuleOptions,
    private readonly hooks: ClientLogServiceHooks,
  ) {
    this.fs = options.fs ?? realClientLogFs;
    this.env = options.env ?? defaultLocatorEnv();
    this.backfillBytes = options.backfillBytes ?? BACKFILL_BYTES;
  }

  // ---- lifecycle ------------------------------------------------------------

  start(): void {
    this.reloadGameSettings();
    this.locate();
    if (!this.options.manualPolls) {
      this.timer = setInterval(() => this.poll(), this.options.pollMs ?? POLL_MS);
      this.timer.unref?.();
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.listeners.clear();
  }

  /** Re-read the game config (both Documents locations; the newest wins). */
  reloadGameSettings(): GameSettings | undefined {
    const profile = this.options.userProfile ?? process.env.USERPROFILE ?? "";
    let best: { file: string; mtimeMs: number } | undefined;
    for (const file of profile ? gameSettingsCandidates(profile) : []) {
      const stat = this.fs.stat(file);
      if (stat && (!best || stat.mtimeMs > best.mtimeMs)) best = { file, mtimeMs: stat.mtimeMs };
    }
    const text = best ? this.fs.readText(best.file) : undefined;
    this.gameSettings = text === undefined ? undefined : parseGameSettingsIni(text);
    return this.gameSettings;
  }

  // ---- ClientLogService -----------------------------------------------------

  status(): ClientLogStatus {
    const status: ClientLogStatus = {
      source: this.source,
      watching: this.tail !== undefined && this.error === undefined,
    };
    if (this.tail) status.file = this.tail.file;
    if (this.sizeBytes !== undefined) status.sizeBytes = this.sizeBytes;
    if (this.lastLineAt) status.lastLineAt = this.lastLineAt;
    if (this.error) status.error = this.error;
    if (this.character) status.character = { ...this.character };
    if (this.area) status.area = { ...this.area };
    if (this.gameSettings) status.gameSettings = { ...this.gameSettings };
    return status;
  }

  on<K extends ClientLogEventKind | "*">(kind: K, callback: (event: EventOf<K>) => void): () => void {
    let set = this.listeners.get(kind);
    if (!set) {
      set = new Set();
      this.listeners.set(kind, set);
    }
    const listener = callback as (event: ClientLogEvent) => void;
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  }

  recent(kind?: ClientLogEventKind, limit?: number): ClientLogEvent[] {
    const events = kind ? this.ring.filter((event) => event.kind === kind) : this.ring.slice();
    const max = limit !== undefined && Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : undefined;
    return max === undefined ? events : events.slice(-max);
  }

  setFile(file: string | undefined): ClientLogStatus {
    const trimmed = typeof file === "string" ? file.trim() : "";
    this.hooks.settings.set({ file: trimmed || undefined });
    this.locate();
    return this.status();
  }

  async replayTail(bytes?: number): Promise<number> {
    if (!this.tail) return 0;
    const window = bytes !== undefined && bytes > 0 ? Math.floor(bytes) : this.backfillBytes;
    this.ring.length = 0;
    return this.backfill(this.tail, window);
  }

  /** Parse + emit one line as if the game had written it (gated by settings.allowInject). */
  inject(line: string): ClientLogEvent | undefined {
    if (!this.hooks.settings.get().allowInject) {
      throw new Error('client-log:inject is disabled (settings "client-log".allowInject is false)');
    }
    const event = parseClientLogLine(String(line), areaInfo);
    if (event) this.record(event, true);
    return event;
  }

  async browse(): Promise<ClientLogStatus> {
    const dialog = this.options.dialog ?? (await import("electron")).dialog;
    const result = await dialog.showOpenDialog({
      title: "Choose Path of Exile 2's Client.txt",
      defaultPath: this.tail?.file,
      filters: [{ name: "Client.txt", extensions: ["txt"] }],
      properties: ["openFile"],
    });
    if (result.canceled || !result.filePaths[0]) return this.status();
    return this.setFile(result.filePaths[0]);
  }

  // ---- tailing --------------------------------------------------------------

  /** Resolve the file (override → Steam → standalone → Epic) and (re)start the tail. */
  locate(): void {
    const override = this.hooks.settings.get().file;
    const located = locateClientLog(this.env, this.fs, override);
    this.pollsSinceLocate = 0;
    this.error = undefined;
    if (override && located.source !== "override") {
      this.error = `Client.txt override not found: ${override}`;
    }
    if (!located.file) {
      this.tail = undefined;
      this.source = "none";
      this.sizeBytes = undefined;
      if (!this.error) this.error = "Client.txt not found (set the path in Tools → Settings)";
      this.emitStatus();
      return;
    }
    if (this.tail?.file === located.file && this.source === located.source && !this.error) {
      this.emitStatus();
      return;
    }
    this.source = located.source;
    this.tail = { file: located.file, source: located.source, offset: 0, carry: Buffer.alloc(0) };
    this.ring.length = 0;
    this.character = undefined;
    this.area = undefined;
    void this.backfill(this.tail, this.backfillBytes);
    this.emitStatus();
  }

  /** One tick: stat, read appended bytes, handle truncation. Safe to call directly in tests. */
  poll(): void {
    if (this.disposed) return;
    if (!this.tail) {
      if (++this.pollsSinceLocate >= RELOCATE_EVERY_POLLS) this.locate();
      return;
    }
    const tail = this.tail;
    const stat = this.fs.stat(tail.file);
    if (!stat) {
      if (!this.error) {
        this.error = `Client.txt disappeared: ${tail.file}`;
        this.emitStatus();
      }
      return;
    }
    if (this.error) {
      this.error = undefined;
      this.emitStatus();
    }
    this.sizeBytes = stat.size;
    if (stat.size < tail.offset) {
      // Truncated or rotated: start over, bounded like the initial backfill.
      this.hooks.log("info", `Client.txt shrank (${tail.offset} → ${stat.size} bytes); restarting tail`);
      tail.offset = 0;
      tail.carry = Buffer.alloc(0);
      void this.backfill(tail, this.backfillBytes);
      return;
    }
    if (stat.size === tail.offset) return;
    const end = Math.min(stat.size, tail.offset + MAX_READ_PER_POLL);
    let chunk: Buffer;
    try {
      chunk = this.fs.readRange(tail.file, tail.offset, end);
    } catch (error) {
      this.error = `Client.txt read failed: ${error instanceof Error ? error.message : String(error)}`;
      this.emitStatus();
      return;
    }
    tail.offset += chunk.length;
    this.consume(tail, chunk, true);
  }

  private backfill(tail: TailState, windowBytes: number): number {
    const stat = this.fs.stat(tail.file);
    if (!stat) {
      this.error = `Client.txt disappeared: ${tail.file}`;
      return 0;
    }
    this.sizeBytes = stat.size;
    const start = Math.max(0, stat.size - windowBytes);
    let chunk: Buffer;
    try {
      chunk = this.fs.readRange(tail.file, start, stat.size);
    } catch (error) {
      this.error = `Client.txt read failed: ${error instanceof Error ? error.message : String(error)}`;
      return 0;
    }
    if (start > 0) {
      // The window almost certainly begins mid-line; drop that fragment.
      const firstNewline = chunk.indexOf(NEWLINE);
      chunk = firstNewline < 0 ? Buffer.alloc(0) : chunk.subarray(firstNewline + 1);
    }
    // Everything up to the current size is consumed (the dropped fragment included).
    tail.offset = stat.size;
    tail.carry = Buffer.alloc(0);
    const before = this.ring.length;
    this.consume(tail, chunk, false);
    return this.ring.length - before;
  }

  /** Splits complete lines off `carry + chunk`, keeping the trailing fragment as bytes. */
  private consume(tail: TailState, chunk: Buffer, live: boolean): void {
    const data = tail.carry.length ? Buffer.concat([tail.carry, chunk]) : chunk;
    const lastNewline = data.lastIndexOf(NEWLINE);
    if (lastNewline < 0) {
      tail.carry = Buffer.from(data);
      return;
    }
    tail.carry = Buffer.from(data.subarray(lastNewline + 1));
    const text = data.subarray(0, lastNewline).toString("utf8");
    for (const raw of text.split("\n")) {
      const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      if (!line) continue;
      const event = parseClientLogLine(line, areaInfo);
      if (event) this.record(event, live);
    }
  }

  private record(event: ClientLogEvent, live: boolean): void {
    this.ring.push(event);
    if (this.ring.length > RING_CAPACITY) this.ring.splice(0, this.ring.length - RING_CAPACITY);
    this.lastLineAt = event.at;
    let statusChanged = false;
    if (event.kind === "level-up") {
      this.character = {
        name: event.character,
        className: event.className,
        level: event.level,
        seenAt: event.at,
      };
      statusChanged = true;
    } else if (event.kind === "area") {
      this.area = event;
      statusChanged = true;
    }
    if (!live) return;
    for (const listener of [...(this.listeners.get(event.kind) ?? []), ...(this.listeners.get("*") ?? [])]) {
      try {
        listener(event);
      } catch (error) {
        this.hooks.log("warn", `client-log listener failed for ${event.kind}`, error);
      }
    }
    this.hooks.emit("client-log:event", event);
    if (statusChanged) this.emitStatus();
  }

  private emitStatus(): void {
    this.hooks.emit("client-log:status", this.status());
  }
}

export function createClientLogModule(options: ClientLogModuleOptions = {}): FeatureModule {
  return {
    id: "clientLog",
    register(ctx: FeatureContext) {
      const settings = ctx.settings.namespace<ClientLogSettings>("client-log", normalizeClientLogSettings);
      const service = new ClientLogTailer(options, {
        settings,
        emit: (channel, payload) => ctx.emit(channel, payload),
        log: (level, message, detail) => ctx.log({ feature: "clientLog", level, message, detail }),
      });
      ctx.provide("clientLog", service);
      ctx.handle("client-log:status", () => service.status());
      ctx.handle("client-log:recent", (kind?: string, limit?: number) =>
        service.recent(kind ? (kind as ClientLogEventKind) : undefined, limit),
      );
      ctx.handle("client-log:set-file", (file: string | null) => service.setFile(file ?? undefined));
      ctx.handle("client-log:browse-file", () => service.browse());
      ctx.handle("client-log:inject", (line: string) => service.inject(line));
      ctx.handle("client-log:reload-settings", () => {
        service.reloadGameSettings();
        return service.status();
      });
      service.start();
      return { dispose: () => service.dispose() };
    },
  };
}

export const clientLogModule: FeatureModule = createClientLogModule();
