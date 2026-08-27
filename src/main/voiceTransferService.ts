import type { LocalSpeechRecognizer } from "../adapters/windowsSpeechRecognizer.js";
import {
  resolveVoiceCommand,
  voiceRecognitionPhrases,
  type VoiceTransferConfig,
  type VoiceTransferState,
} from "../core/voiceTransfer.js";
import type { RuntimeMode } from "../core/types.js";
import type {
  AssistiveRunRequest,
  AssistiveRunResult,
} from "./assistiveRunService.js";

interface AssistiveStatus {
  running: boolean;
  killLatched: boolean;
  qaOptIn: boolean;
  searchCalibrated: boolean;
}

interface VoiceTransferServiceOptions {
  mode: RuntimeMode;
  recognizer: LocalSpeechRecognizer;
  config: () => VoiceTransferConfig;
  assistiveStatus: () => AssistiveStatus;
  startTransfer: (request: AssistiveRunRequest) => Promise<AssistiveRunResult>;
  stopTransfer: (reason: string) => void | Promise<void>;
  onState?: (state: VoiceTransferState) => void;
}

interface ActiveVoiceRun {
  abort: AbortController;
  source: "hotkey" | "ui";
}

function timestamp(): string {
  return new Date().toISOString();
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

export class VoiceTransferService {
  private active?: ActiveVoiceRun;
  private current: VoiceTransferState = {
    phase: "idle",
    updatedAt: timestamp(),
  };

  constructor(private readonly options: VoiceTransferServiceOptions) {}

  get status(): VoiceTransferState {
    return {
      ...this.current,
      wantedClasses: this.current.wantedClasses
        ? [...this.current.wantedClasses]
        : undefined,
    };
  }

  private publish(
    state: Omit<VoiceTransferState, "updatedAt">,
  ): VoiceTransferState {
    this.current = { ...state, updatedAt: timestamp() };
    try {
      this.options.onState?.(this.status);
    } catch {
      // UI/audit observers must never bypass the transfer service's own gates.
    }
    return this.status;
  }

  private preflight(source: "hotkey" | "ui"): VoiceTransferState | undefined {
    const config = this.options.config();
    const status = this.options.assistiveStatus();
    let error: string | undefined;
    if (this.options.mode !== "authorized-qa") {
      error = "authorized-qa-build-required";
    } else if (!config.enabled) {
      error = "voice-transfer-disabled";
    } else if (status.running) {
      error = "assistive-run-already-running";
    } else if (status.killLatched) {
      error = "kill-switch-latched";
    } else if (!status.searchCalibrated) {
      error = "stash-search-not-calibrated";
    } else if (!config.dryRun && !status.qaOptIn) {
      error = "qa-local-opt-in-required";
    } else if (!config.dryRun && !config.qaAcknowledged) {
      error = "qa-acknowledgement-required";
    } else if (!config.dryRun && config.allowlist.length === 0) {
      error = "process-allowlist-required";
    }
    return error
      ? this.publish({ phase: "error", source, error })
      : undefined;
  }

  async trigger(source: "hotkey" | "ui" = "hotkey"): Promise<VoiceTransferState> {
    if (this.active) return this.status;
    const blocked = this.preflight(source);
    if (blocked) return blocked;

    const config = this.options.config();
    const active: ActiveVoiceRun = {
      abort: new AbortController(),
      source,
    };
    this.active = active;
    this.publish({ phase: "listening", source });
    let transcript: string | undefined;
    let confidence: number | undefined;
    try {
      const heard = await this.options.recognizer.recognize({
        signal: active.abort.signal,
        timeoutMs: config.recognitionTimeoutMs,
        phrases: voiceRecognitionPhrases(),
        allowDictation: config.allowLiteralFallback,
      });
      transcript = heard.text;
      confidence = heard.confidence;
      if (active.abort.signal.aborted) {
        return this.status;
      }
      if (heard.confidence < config.minimumConfidence) {
        throw new Error(
          `voice-confidence-too-low:${heard.confidence.toFixed(2)}`,
        );
      }
      const command = resolveVoiceCommand(
        heard.text,
        config.allowLiteralFallback,
      );
      this.publish({
        phase: "recognized",
        source,
        transcript: command.transcript,
        confidence: heard.confidence,
        commandMode: command.mode,
        wantedClasses: command.wantedClasses,
        searchQuery: command.searchQuery,
      });
      if (active.abort.signal.aborted) {
        return this.status;
      }
      this.publish({
        phase: "transferring",
        source,
        transcript: command.transcript,
        confidence: heard.confidence,
        commandMode: command.mode,
        wantedClasses: command.wantedClasses,
        searchQuery: command.searchQuery,
      });
      const result = await this.options.startTransfer({
        kind: "fill",
        dryRun: config.dryRun,
        wantedClasses: command.wantedClasses,
        searchQuery: command.searchQuery,
        uniqueAcrossCycles: false,
        qaAcknowledged: config.qaAcknowledged,
        allowlist: config.allowlist,
        actionsPerMinute: config.actionsPerMinute,
        maxItems: config.maxItems,
      });
      if (active.abort.signal.aborted) {
        return this.status;
      }
      return this.publish({
        phase: result.ok ? "complete" : "error",
        source,
        transcript: command.transcript,
        confidence: heard.confidence,
        commandMode: command.mode,
        wantedClasses: command.wantedClasses,
        searchQuery: command.searchQuery,
        transferReason: result.reason,
        ...(result.ok ? {} : { error: result.reason }),
      });
    } catch (reason) {
      if (active.abort.signal.aborted) {
        if (this.current.phase !== "cancelled") {
          this.publish({
            phase: "cancelled",
            source,
            transcript,
            confidence,
            transferReason: "cancelled",
          });
        }
        return this.status;
      }
      return this.publish({
        phase: "error",
        source,
        transcript,
        confidence,
        error: errorMessage(reason),
      });
    } finally {
      if (this.active === active) this.active = undefined;
    }
  }

  async cancel(reason = "voice-operator-cancel"): Promise<VoiceTransferState> {
    const active = this.active;
    if (!active) return this.status;
    const wasTransferring = this.current.phase === "transferring";
    active.abort.abort(reason);
    if (wasTransferring) {
      await this.options.stopTransfer(reason);
    }
    return this.publish({
      phase: "cancelled",
      source: active.source,
      transcript: this.current.transcript,
      confidence: this.current.confidence,
      commandMode: this.current.commandMode,
      wantedClasses: this.current.wantedClasses,
      searchQuery: this.current.searchQuery,
      transferReason: reason,
    });
  }
}
