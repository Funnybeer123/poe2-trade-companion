/**
 * Chat command service: types exactly ONE chat line (Enter, text, Enter),
 * fills the stash search box once (Ctrl+F, text, Enter), or presses Ctrl+C
 * once over the hovered item (`copyHoveredItem`) per call, through the
 * PowerShell input host (scripts/win-input-host.ps1 via startWinHost).
 *
 * Guard order for every attempt: kill switch → feature enabled → text rules
 * → dry-run (answers without touching the host) → rate limit → another
 * input host running → host `rect` confirms the foreground window is an
 * allowlisted Path of Exile process → the keys, each answered by the host
 * and each preceded by another kill-switch check. Attempts are serialized
 * so two gestures can never interleave their keystrokes.
 *
 * Every attempt appends one entry to the QA action trace
 * (`<userData>/assistive-artifacts/qa-action-trace.jsonl`, the shape
 * src/main/index.ts appendVoiceAudit uses, `module: "chat"`). The host is
 * started lazily and closed after `idleCloseMs` without an attempt.
 */
import { execFile } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { startWinHost, type WinReply } from "../adapters/winHost.js";
import { DEFAULT_POE_PROCESS_ALLOWLIST } from "../core/capabilities.js";
import {
  ChatRateLimiter,
  resolvePlaceholders,
  sanitizeChatText,
  stashSearchHotkey,
} from "../core/chatCommands.js";
import { looksLikePoeItemText } from "../core/parseItem.js";
import type {
  ChatBlockReason,
  ChatCommandOutcome,
  ChatCommandRequest,
  ChatCommandSettings,
  ChatCommandStatus,
  ChatCopyOutcome,
  ChatCopyRequest,
  ChatSource,
  PlaceholderContext,
  StashSearchOptions,
} from "../shared/chatCommands.js";

const execFileAsync = promisify(execFile);

/** How long the clipboard may take to show the hovered item after Ctrl+C. */
export const COPY_HOVERED_TIMEOUT_MS = 900;
/** Gap between two `clipboard` reads while waiting for the game to answer. */
export const COPY_HOVERED_POLL_MS = 40;
const COPY_HOVERED_MAX_POLLS = Math.ceil(COPY_HOVERED_TIMEOUT_MS / COPY_HOVERED_POLL_MS) + 1;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/** The slice of a started win host the service uses (fakeable). */
export interface ChatHost {
  send(payload: Record<string, unknown>): Promise<WinReply>;
  close(): Promise<void>;
}

export interface ChatCommandService {
  send(request: ChatCommandRequest): Promise<ChatCommandOutcome>;
  stashSearch(text: string, reason: string, options?: StashSearchOptions): Promise<ChatCommandOutcome>;
  /**
   * One audited Ctrl+C over whatever the cursor hovers in the game. Same
   * gates as `send`; on success the item text is left on the clipboard AND
   * returned, on failure the clipboard the user had is put back.
   */
  copyHoveredItem(request: ChatCopyRequest): Promise<ChatCopyOutcome>;
  status(): ChatCommandStatus;
  resolvePlaceholders(template: string, context: PlaceholderContext): string;
}

/** A warm chat host can still accept input until its bounded idle timer closes it. */
export function chatHostBusyReason(service: Pick<ChatCommandService, "status"> | undefined): string | undefined {
  return service?.status().hostRunning ? "Wait for the chat input host to go idle before arming combat." : undefined;
}

export interface ChatCommandServiceOptions {
  /** Electron userData; the trace lands in `<userDataDir>/assistive-artifacts/`. */
  userDataDir: string;
  buildMode: string;
  killSwitchLatched: () => boolean;
  dryRun: () => boolean;
  settings: () => ChatCommandSettings;
  /** Injected in tests; defaults to startWinHost. */
  hostFactory?: () => ChatHost;
  /** True when another win-input-host.ps1 is alive (numpad daemon, a CLI, the flask guard). */
  otherHostRunning?: () => Promise<boolean>;
  /** VK of the game's stash-search key when the client log service knows it. */
  searchKey?: () => number | undefined;
  allowedProcesses?: readonly string[];
  /** Injectable clock (ms) for the limiter and timestamps. */
  now?: () => number;
  /** Injectable delay between clipboard polls (tests advance their own clock). */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Reads this process's clipboard (Electron `clipboard.readText`). Only used
   * by `copyHoveredItem` in dry-run, where no host may be started: without it
   * the dry-run answer carries no text.
   */
  readClipboard?: () => string;
  onOutcome?: (outcome: ChatCommandOutcome) => void;
  onStatus?: (status: ChatCommandStatus) => void;
  log?: (level: "info" | "warn" | "error", message: string, detail?: unknown) => void;
  /** Injectable trace writer (defaults to appendFileSync with mkdir -p). */
  appendTrace?: (file: string, line: string) => void;
}

export type ChatTraceKind = "send" | "stash-search" | "copy-hovered";

/** One trace line per attempt; mirrors appendVoiceAudit's field names. */
export interface ChatTraceEntry {
  timestamp: string;
  type: "chat-command";
  scenarioId: "chat-commands";
  module: "chat";
  mode: string;
  kind: ChatTraceKind;
  source: ChatSource;
  decisionRule: "one-chat-line-per-user-gesture";
  /** The typed line, or "ctrl+c" for a copy-hovered gesture — never item text. */
  input: string;
  result: "emitted" | "blocked" | "dry-run";
  reason: string;
  blockedBy?: ChatBlockReason;
  error?: string;
  /** Host ops that were actually sent, in order ("focus", "rect", "hotkey:enter", "type", …). */
  hostOps: string[];
}

class Blocked extends Error {
  constructor(
    readonly blockedBy: ChatBlockReason,
    message: string,
  ) {
    super(message);
  }
}

function normalizedProcess(name: unknown): string {
  return String(name ?? "").trim().replace(/\.exe$/i, "").toLowerCase();
}

/**
 * Minimal "another input host" probe. No shared helper exists: the sorter
 * and the tab admin each own their host for the run's lifetime and rely on
 * their own `running` flags (src/main/stashSortService.ts,
 * src/main/stashTabAdminService.ts), and the daemon/CLIs are separate
 * processes, so the only cross-process signal is the process list. Counts
 * PowerShell processes whose command line names win-input-host.ps1; the
 * enumeration mirrors listPoeProcessesUncached in src/main/index.ts.
 */
export async function defaultOtherHostRunning(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-Command",
      "@(Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | Where-Object { $_.CommandLine -like '*win-input-host.ps1*' -or $_.CommandLine -like '*win-combat-host.ps1*' }).Count",
    ]);
    const count = Number.parseInt(stdout.trim(), 10);
    return Number.isFinite(count) && count > 0;
  } catch {
    return false;
  }
}

function defaultAppendTrace(file: string, line: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, line, "utf8");
}

export function chatTraceFile(userDataDir: string): string {
  return path.join(userDataDir, "assistive-artifacts", "qa-action-trace.jsonl");
}

export class ChatCommandServiceImpl implements ChatCommandService {
  private host: ChatHost | undefined;
  private idleTimer: NodeJS.Timeout | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private lastOutcome: ChatCommandOutcome | undefined;
  private disposed = false;
  private readonly limiter: ChatRateLimiter;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly traceFile: string;
  private readonly allowed: string[];
  private copySeq = 0;

  constructor(private readonly options: ChatCommandServiceOptions) {
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? defaultSleep;
    this.limiter = new ChatRateLimiter({ now: this.now });
    this.traceFile = chatTraceFile(options.userDataDir);
    this.allowed = (options.allowedProcesses ?? DEFAULT_POE_PROCESS_ALLOWLIST).map(normalizedProcess);
  }

  resolvePlaceholders(template: string, context: PlaceholderContext): string {
    return resolvePlaceholders(template, context);
  }

  status(): ChatCommandStatus {
    const settings = this.options.settings();
    return {
      enabled: settings.enabled,
      hostRunning: this.host !== undefined,
      ...(this.lastOutcome ? { lastOutcome: this.lastOutcome } : {}),
      sentThisMinute: this.limiter.sentThisMinute(),
      maxPerMinute: settings.maxPerMinute,
      dryRun: this.options.dryRun(),
    };
  }

  /** Re-announce the status (settings changed, host closed). */
  announce(): void {
    this.options.onStatus?.(this.status());
  }

  send(request: ChatCommandRequest): Promise<ChatCommandOutcome> {
    const source: ChatSource = request?.source ?? "other";
    return this.enqueue(() =>
      this.attempt({
        kind: "send",
        text: request?.text,
        reason: String(request?.reason ?? ""),
        source,
        focus: request?.focus === true,
        keys: () => "enter",
      }),
    );
  }

  stashSearch(text: string, reason: string, options?: StashSearchOptions): Promise<ChatCommandOutcome> {
    return this.enqueue(() =>
      this.attempt({
        kind: "stash-search",
        text,
        reason: String(reason ?? ""),
        source: "stash-search",
        focus: options?.focus === true,
        keys: () => stashSearchHotkey(this.options.searchKey?.()),
      }),
    );
  }

  copyHoveredItem(request: ChatCopyRequest): Promise<ChatCopyOutcome> {
    const source: ChatSource = request?.source ?? "other";
    const reason = String(request?.reason ?? "");
    return this.enqueue(() => this.attemptCopy(reason, source));
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.clearIdleTimer();
    await this.closeHost();
  }

  private enqueue<T extends ChatCommandOutcome>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async attempt(input: {
    kind: "send" | "stash-search";
    text: unknown;
    reason: string;
    source: ChatSource;
    focus: boolean;
    /** The key that opens the box: Enter for chat, the search hotkey for the stash. */
    keys: () => string;
  }): Promise<ChatCommandOutcome> {
    const at = new Date(this.now()).toISOString();
    const hostOps: string[] = [];
    const check = sanitizeChatText(input.text);
    let outcome: ChatCommandOutcome;
    try {
      this.assertNotLatched();
      if (!this.options.settings().enabled) throw new Blocked("disabled", "chat commands are disabled in settings");
      if (check.blockedBy) throw new Blocked(check.blockedBy, check.error ?? check.blockedBy);
      if (this.options.dryRun()) {
        outcome = { ok: true, dryRun: true, sent: check.text, at };
      } else {
        const rate = this.limiter.check({ maxPerMinute: this.options.settings().maxPerMinute });
        if (!rate.ok) {
          throw new Blocked(
            "rate-limit",
            `${rate.reason === "min-gap" ? "lines must be 400 ms apart" : "per-minute budget spent"}; retry in ${rate.retryAfterMs} ms`,
          );
        }
        const host = await this.ensureHost();
        if (input.focus) {
          hostOps.push("focus");
          const focused = await this.hostOp(host, { op: "focus" });
          if (!focused.ok) throw new Blocked("host-error", String(focused.error ?? "focus-failed"));
          if (focused.focused === false) throw new Blocked("not-foreground", "Path of Exile refused focus");
        }
        hostOps.push("rect");
        const hwnd = await this.confirmForeground(host);
        this.limiter.record();
        const opener = input.keys();
        const steps: Array<Record<string, unknown>> = [
          { op: "hotkey", keys: opener },
          { op: "type", text: check.text },
          { op: "hotkey", keys: "enter" },
        ];
        for (const [index, step] of steps.entries()) {
          hostOps.push(step.op === "type" ? "type" : `hotkey:${String(step.keys)}`);
          try {
            const reply = await this.hostOp(host, {
              ...step,
              expectedHwnd: hwnd,
              requireForeground: true,
            });
            if (!reply.ok) {
              const error = String(reply.error ?? "win-input-failed");
              throw new Blocked(error === "focus-lost" ? "not-foreground" : "host-error", error);
            }
            if (reply.focused === false) throw new Blocked("not-foreground", "focus-lost");
          } catch (error) {
            if (error instanceof Blocked && index > 0) {
              error.message = `${error.message} (stopped after ${index} of ${steps.length} keys; the chat box may still be open)`;
            }
            throw error;
          }
        }
        outcome = { ok: true, dryRun: false, sent: check.text, at };
      }
    } catch (error) {
      if (error instanceof Blocked) {
        outcome = {
          ok: false,
          dryRun: false,
          ...(check.text ? { sent: check.text } : {}),
          blockedBy: error.blockedBy,
          error: error.message,
          at,
        };
        if (error.blockedBy === "host-error") await this.closeHost();
      } else {
        const message = error instanceof Error ? error.message : String(error);
        outcome = { ok: false, dryRun: false, sent: check.text, blockedBy: "host-error", error: message, at };
        await this.closeHost();
      }
    }
    this.finish(input, check.text || String(input.text ?? "").slice(0, 400), outcome, hostOps);
    return outcome;
  }

  /**
   * One Ctrl+C over whatever the cursor hovers, with the same gate order as
   * `attempt` (kill switch → enabled → dry-run → rate limit → another host →
   * `rect`). Then: read the clipboard the user had, park a sentinel on it,
   * press Ctrl+C once, and poll the clipboard until the game replaces the
   * sentinel with item text. The sentinel is what separates "the game
   * answered" from "the clipboard already held an item from last time".
   *
   * Every host op is foreground-pinned to the window `rect` confirmed, so the
   * host never focuses Path of Exile behind the user's back (the script's
   * generic op path calls Focus-Poe when `requireForeground` is absent).
   */
  private async attemptCopy(reason: string, source: ChatSource): Promise<ChatCopyOutcome> {
    const at = new Date(this.now()).toISOString();
    const hostOps: string[] = [];
    let outcome: ChatCommandOutcome;
    let text: string | undefined;
    try {
      this.assertNotLatched();
      if (!this.options.settings().enabled) throw new Blocked("disabled", "chat commands are disabled in settings");
      if (this.options.dryRun()) {
        const current = this.options.readClipboard?.();
        text = looksLikePoeItemText(current) ? current : undefined;
        outcome = { ok: true, dryRun: true, at };
      } else {
        const rate = this.limiter.check({ maxPerMinute: this.options.settings().maxPerMinute });
        if (!rate.ok) {
          throw new Blocked(
            "rate-limit",
            `${rate.reason === "min-gap" ? "lines must be 400 ms apart" : "per-minute budget spent"}; retry in ${rate.retryAfterMs} ms`,
          );
        }
        const host = await this.ensureHost();
        hostOps.push("rect");
        const hwnd = await this.confirmForeground(host);
        hostOps.push("clipboard");
        const before = await this.readHostClipboard(host, hwnd);
        this.copySeq += 1;
        const sentinel = `poe2-trade-companion:copy-hovered:${this.now()}:${this.copySeq}`;
        this.limiter.record();
        hostOps.push("setclipboard");
        const parked = await this.hostOp(host, {
          op: "setclipboard",
          text: sentinel,
          expectedHwnd: hwnd,
          requireForeground: true,
        });
        if (!parked.ok) {
          const error = String(parked.error ?? "set-clipboard-failed");
          throw new Blocked(error === "focus-lost" ? "not-foreground" : "host-error", error);
        }
        try {
          hostOps.push("hotkey:ctrlc");
          const copied = await this.hostOp(host, {
            op: "hotkey",
            keys: "ctrlc",
            expectedHwnd: hwnd,
            requireForeground: true,
          });
          if (!copied.ok) {
            const error = String(copied.error ?? "win-input-failed");
            throw new Blocked(error === "focus-lost" ? "not-foreground" : "host-error", error);
          }
          if (copied.focused === false) throw new Blocked("not-foreground", "focus-lost");
          const deadline = this.now() + COPY_HOVERED_TIMEOUT_MS;
          for (let poll = 0; poll < COPY_HOVERED_MAX_POLLS; poll += 1) {
            hostOps.push("clipboard");
            const current = await this.readHostClipboard(host, hwnd);
            if (current !== sentinel && looksLikePoeItemText(current)) {
              text = current;
              break;
            }
            if (this.now() >= deadline) break;
            await this.sleep(COPY_HOVERED_POLL_MS);
          }
          if (text === undefined) {
            throw new Blocked(
              "timeout",
              `no item text on the clipboard within ${COPY_HOVERED_TIMEOUT_MS} ms (is an item under the cursor?)`,
            );
          }
        } catch (error) {
          // Put the user's clipboard back before surfacing the failure. This
          // is a clipboard write, not game input, so it also runs when the
          // kill switch latched mid-poll — but it stays foreground-pinned,
          // so a lost focus leaves the sentinel and only warns.
          hostOps.push("setclipboard");
          await host
            .send({ op: "setclipboard", text: before, expectedHwnd: hwnd, requireForeground: true })
            .then((reply) => {
              if (reply.ok !== true) this.options.log?.("warn", "clipboard restore refused", reply.error);
            })
            .catch((restoreError: unknown) => {
              this.options.log?.("warn", "clipboard restore failed", restoreError);
            });
          throw error;
        }
        // The item text stays on the clipboard on purpose: the caller (and
        // the user's own Ctrl+V) expect it there.
        outcome = { ok: true, dryRun: false, at };
      }
    } catch (error) {
      if (error instanceof Blocked) {
        outcome = { ok: false, dryRun: false, blockedBy: error.blockedBy, error: error.message, at };
        if (error.blockedBy === "host-error") await this.closeHost();
      } else {
        const message = error instanceof Error ? error.message : String(error);
        outcome = { ok: false, dryRun: false, blockedBy: "host-error", error: message, at };
        await this.closeHost();
      }
      text = undefined;
    }
    // `finish` gets the outcome WITHOUT the item text: the trace, the status
    // and the `chat:sent` event never carry what the item said.
    this.finish({ kind: "copy-hovered", source, reason }, "ctrl+c", outcome, hostOps);
    return text === undefined ? outcome : { ...outcome, text };
  }

  private async readHostClipboard(host: ChatHost, hwnd: string): Promise<string> {
    const reply = await this.hostOp(host, { op: "clipboard", expectedHwnd: hwnd, requireForeground: true });
    if (!reply.ok) {
      const error = String(reply.error ?? "clipboard-read-failed");
      throw new Blocked(error === "focus-lost" ? "not-foreground" : "host-error", error);
    }
    if (reply.focused === false) throw new Blocked("not-foreground", "focus-lost");
    return typeof reply.text === "string" ? reply.text : "";
  }

  private assertNotLatched(): void {
    if (this.options.killSwitchLatched()) throw new Blocked("kill-switch", "kill switch is latched");
  }

  /** Every host op re-checks the kill switch first: latching mid-sequence stops the next key. */
  private async hostOp(host: ChatHost, payload: Record<string, unknown>): Promise<WinReply> {
    this.assertNotLatched();
    return host.send(payload);
  }

  private async confirmForeground(host: ChatHost): Promise<string> {
    const rect = await this.hostOp(host, { op: "rect" });
    if (!rect.ok) {
      const error = String(rect.error ?? "target-window-missing");
      if (error === "no-poe-window" || error === "target-window-lost") {
        throw new Blocked("not-foreground", `Path of Exile window not found (${error})`);
      }
      throw new Blocked("host-error", error);
    }
    const process = normalizedProcess(rect.process);
    if (!process || !this.allowed.includes(process)) {
      throw new Blocked("process-not-allowed", `process "${String(rect.process ?? "")}" is not allowlisted`);
    }
    if (rect.foregroundIsPoe !== true) {
      throw new Blocked("not-foreground", "Path of Exile is not the foreground window");
    }
    return String(rect.hwnd ?? "");
  }

  private async ensureHost(): Promise<ChatHost> {
    if (this.disposed) throw new Blocked("host-error", "chat command service is disposed");
    if (this.host) return this.host;
    if (await (this.options.otherHostRunning ?? defaultOtherHostRunning)()) {
      throw new Blocked("another-host", "another input host is running (daemon, CLI or flask guard)");
    }
    this.assertNotLatched();
    const host = (this.options.hostFactory ?? startWinHost)();
    this.host = host;
    return host;
  }

  private async closeHost(): Promise<void> {
    this.clearIdleTimer();
    const host = this.host;
    this.host = undefined;
    if (!host) return;
    await host.close().catch((error: unknown) => {
      this.options.log?.("warn", "chat host close failed", error);
    });
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private armIdleTimer(): void {
    this.clearIdleTimer();
    if (!this.host) return;
    const timer = setTimeout(() => {
      this.idleTimer = undefined;
      void this.closeHost().then(() => this.announce());
    }, this.options.settings().idleCloseMs);
    timer.unref?.();
    this.idleTimer = timer;
  }

  private finish(
    input: { kind: ChatTraceKind; source: ChatSource; reason: string },
    text: string,
    outcome: ChatCommandOutcome,
    hostOps: string[],
  ): void {
    this.lastOutcome = outcome;
    const entry: ChatTraceEntry = {
      timestamp: outcome.at,
      type: "chat-command",
      scenarioId: "chat-commands",
      module: "chat",
      mode: this.options.buildMode,
      kind: input.kind,
      source: input.source,
      decisionRule: "one-chat-line-per-user-gesture",
      input: text,
      result: outcome.dryRun ? "dry-run" : outcome.ok ? "emitted" : "blocked",
      reason: input.reason,
      ...(outcome.blockedBy ? { blockedBy: outcome.blockedBy } : {}),
      ...(outcome.error ? { error: outcome.error } : {}),
      hostOps,
    };
    try {
      (this.options.appendTrace ?? defaultAppendTrace)(this.traceFile, `${JSON.stringify(entry)}\n`);
    } catch (error) {
      this.options.log?.("warn", "chat trace append failed", error);
    }
    this.armIdleTimer();
    this.options.onOutcome?.(outcome);
    this.announce();
  }
}
