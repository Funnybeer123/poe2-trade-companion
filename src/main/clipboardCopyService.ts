import type {
  AutomationScenario,
  BotDecision,
  QaActionTrace,
} from "../core/types.js";

/**
 * Structural subset implemented by GameInputController. Keeping the service
 * injected makes tests/replay independent of native adapters.
 */
export interface ScanGameInputController {
  execute(
    decision: BotDecision,
    scenario: AutomationScenario,
    processName: string,
    evidenceHash: string,
    processAllowed: boolean,
  ): Promise<QaActionTrace[]>;
  clearQueue(): void;
}

export interface ClipboardTextPort {
  readText(): string | Promise<string>;
  writeText(text: string): void | Promise<void>;
  /** Optional OS clipboard sequence number for stronger freshness checks. */
  sequenceNumber?(): number | Promise<number>;
}

export interface ClipboardCopyContext {
  scenario: AutomationScenario;
  processName: string;
  processAllowed: boolean;
  evidenceHash: string;
}

export interface ClipboardCopyRequest {
  /** Controller-ready coordinates produced by an audited coordinate adapter. */
  hoverPoint: { x: number; y: number };
  hoverMs: number;
  copyTimeoutMs: number;
  pollIntervalMs: number;
  afterCopyMs: number;
  maxAttempts?: number;
  context: ClipboardCopyContext;
  signal?: AbortSignal;
  acceptText?: (text: string) => boolean;
}

export type ClipboardCopyStatus =
  | "copied"
  | "copy-timeout"
  | "blocked"
  | "cancelled";

export interface ClipboardCopyResult {
  status: ClipboardCopyStatus;
  text?: string;
  reason: string;
  traces: QaActionTrace[];
}

export interface ClipboardCopyServiceOptions {
  input: ScanGameInputController;
  clipboard: ClipboardTextPort;
  sleep?: (milliseconds: number) => Promise<void>;
  monotonicNow?: () => number;
  sentinelFactory?: () => string;
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function validMilliseconds(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 300_000) {
    throw new Error(`invalid-${name}`);
  }
}

function firstRejectedTrace(traces: readonly QaActionTrace[]): QaActionTrace | undefined {
  return traces.find((trace) => trace.result !== "emitted");
}

function looksLikePoeItemText(text: string): boolean {
  return (
    /(?:^|\n)Item Class:\s*\S/i.test(text) &&
    /(?:^|\n)Rarity:\s*\S/i.test(text)
  );
}

/**
 * Performs only clipboard orchestration. Hover and Ctrl+C are submitted to the
 * injected GameInputController-like port; this class never imports native
 * input or sends host commands directly.
 */
export class ClipboardCopyService {
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly monotonicNow: () => number;
  private readonly sentinelFactory: () => string;

  constructor(private readonly options: ClipboardCopyServiceOptions) {
    this.sleep = options.sleep ?? defaultSleep;
    this.monotonicNow = options.monotonicNow ?? Date.now;
    this.sentinelFactory =
      options.sentinelFactory ??
      (() => `poe2-scan-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  }

  private cancelled(request: ClipboardCopyRequest): boolean {
    return request.signal?.aborted ?? false;
  }

  private async execute(
    decision: BotDecision,
    request: ClipboardCopyRequest,
  ): Promise<QaActionTrace[]> {
    return this.options.input.execute(
      decision,
      request.context.scenario,
      request.context.processName,
      request.context.evidenceHash,
      request.context.processAllowed,
    );
  }

  async copyHovered(request: ClipboardCopyRequest): Promise<ClipboardCopyResult> {
    validMilliseconds(request.hoverMs, "clipboard-hover-ms");
    validMilliseconds(request.copyTimeoutMs, "clipboard-copy-timeout-ms");
    validMilliseconds(request.pollIntervalMs, "clipboard-poll-interval-ms");
    validMilliseconds(request.afterCopyMs, "clipboard-after-copy-ms");
    if (
      !Number.isFinite(request.hoverPoint.x) ||
      !Number.isFinite(request.hoverPoint.y)
    ) {
      throw new Error("invalid-controller-hover-point");
    }
    if (request.pollIntervalMs > request.copyTimeoutMs) {
      throw new Error("clipboard-poll-interval-exceeds-timeout");
    }
    if (request.copyTimeoutMs > 0 && request.pollIntervalMs < 1) {
      throw new Error("clipboard-poll-interval-required");
    }
    const maxAttempts = request.maxAttempts ?? 2;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) {
      throw new Error("invalid-clipboard-copy-attempts");
    }
    if (this.cancelled(request)) {
      this.options.input.clearQueue();
      return {
        status: "cancelled",
        reason: "cancelled-before-hover",
        traces: [],
      };
    }

    const traces: QaActionTrace[] = [];
    const original = await this.options.clipboard.readText();
    const generatedSentinel = this.sentinelFactory();
    const sentinel =
      generatedSentinel === original ? `${generatedSentinel}-fresh` : generatedSentinel;
    try {
      const hoverTraces = await this.execute(
        {
          module: "stash",
          rule: "scanner-hover-cell",
          reason: "hover the bounded scanner target before clipboard copy",
          confidence: 1,
          intended: [{
            kind: "move",
            x: request.hoverPoint.x,
            y: request.hoverPoint.y,
          }],
        },
        request,
      );
      traces.push(...hoverTraces);
      const hoverRejected = firstRejectedTrace(hoverTraces);
      if (hoverRejected || hoverTraces.length === 0) {
        return {
          status: "blocked",
          reason: hoverRejected
            ? `hover-${hoverRejected.result ?? "blocked"}`
            : "hover-controller-produced-no-trace",
          traces,
        };
      }
      await this.sleep(request.hoverMs);
      if (this.cancelled(request)) {
        this.options.input.clearQueue();
        return {
          status: "cancelled",
          reason: "cancelled-after-hover",
          traces,
        };
      }

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        await this.options.clipboard.writeText(sentinel);
        const clearedSequence = await this.options.clipboard.sequenceNumber?.();
        const copyTraces = await this.execute(
          {
            module: "stash",
            rule: "scanner-copy-hovered-item",
            reason:
              `copy hovered item metadata through the audited input controller ` +
              `(attempt ${attempt}/${maxAttempts})`,
            confidence: 1,
            intended: [{ kind: "key", key: "ctrl+c" }],
          },
          request,
        );
        traces.push(...copyTraces);
        const copyRejected = firstRejectedTrace(copyTraces);
        if (copyRejected || copyTraces.length === 0) {
          return {
            status: "blocked",
            reason: copyRejected
              ? `copy-${copyRejected.result ?? "blocked"}`
              : "copy-controller-produced-no-trace",
            traces,
          };
        }

        const deadline = this.monotonicNow() + request.copyTimeoutMs;
        do {
          if (this.cancelled(request)) {
            this.options.input.clearQueue();
            return {
              status: "cancelled",
              reason: "cancelled-during-copy-poll",
              traces,
            };
          }
          const text = await this.options.clipboard.readText();
          const sequence = await this.options.clipboard.sequenceNumber?.();
          const sequenceChanged =
            clearedSequence == null || sequence == null || sequence !== clearedSequence;
          if (
            sequenceChanged &&
            text !== sentinel &&
            (request.acceptText
              ? request.acceptText(text)
              : looksLikePoeItemText(text))
          ) {
            if (request.afterCopyMs > 0) await this.sleep(request.afterCopyMs);
            return {
              status: "copied",
              text,
              reason: "clipboard-updated",
              traces,
            };
          }
          if (this.monotonicNow() >= deadline) break;
          await this.sleep(request.pollIntervalMs);
        } while (true);
      }

      return {
        status: "copy-timeout",
        reason: `fresh-poe-item-not-copied-after-${maxAttempts}-attempts`,
        traces,
      };
    } finally {
      await this.options.clipboard.writeText(original);
    }
  }
}
