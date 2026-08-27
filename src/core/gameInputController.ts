import { KillSwitch } from "./killSwitch.js";
import { evaluateSafety } from "./safety.js";
import type { InputBatchOptions, InputSink } from "./inputSink.js";
import type {
  AutomationScenario,
  BotDecision,
  InputAction,
  QaActionTrace,
  RuntimeMode,
  SafetyContext,
} from "./types.js";

export class GameInputController {
  private readonly queue: InputAction[] = [];
  private traces: QaActionTrace[] = [];
  private actionsThisMinute = 0;
  private budgetWindowStartedAt = Date.now();

  constructor(
    private readonly sink: InputSink,
    private readonly killSwitch: KillSwitch,
    private readonly mode: RuntimeMode,
  ) {}

  get actionTraces(): QaActionTrace[] {
    return this.traces;
  }

  resetMinuteBudget(): void {
    this.actionsThisMinute = 0;
    this.budgetWindowStartedAt = Date.now();
  }

  private refreshMinuteBudget(): void {
    if (Date.now() - this.budgetWindowStartedAt >= 60_000) this.resetMinuteBudget();
  }

  clearQueue(): void {
    this.queue.length = 0;
    this.sink.clear();
  }

  async execute(
    decision: BotDecision,
    scenario: AutomationScenario,
    processName: string,
    evidenceHash: string,
    processAllowed: boolean,
  ): Promise<QaActionTrace[]> {
    const produced: QaActionTrace[] = [];
    if (this.killSwitch.isLatched()) {
      this.clearQueue();
    }
    for (const action of decision.intended) {
      this.refreshMinuteBudget();
      const ctx: SafetyContext = {
        mode: this.mode,
        killSwitchLatched: this.killSwitch.isLatched(),
        dryRun: scenario.dryRun,
        processAllowed,
        moduleEnabled: scenario.enabledModules.includes(decision.module as never) || decision.module === "orchestrator",
        confidence: decision.confidence,
        confidenceThreshold: scenario.confidenceThreshold,
        actionsThisMinute: this.actionsThisMinute,
        actionsPerMinute: scenario.actionsPerMinute,
      };
      const safety = evaluateSafety(ctx);
      const trace: QaActionTrace = {
        timestamp: new Date().toISOString(),
        scenarioId: scenario.id,
        module: decision.module,
        mode: this.mode,
        processName,
        evidenceHash,
        confidence: decision.confidence,
        decisionRule: decision.rule,
        reason: `${decision.reason}; safety=${safety.reason}`,
        input: action,
        result: safety.allow ? "emitted" : "blocked",
      };
      produced.push(trace);
      this.traces.push(trace);
      if (!safety.allow) continue;
      this.actionsThisMinute += 1;
      try {
        await this.sink.emit(action);
      } catch (error) {
        trace.result = "failed";
        trace.reason += `; sink=${error instanceof Error ? error.message : "input-failed"}`;
      }
    }
    return produced;
  }

  async executeBatch(
    decision: BotDecision,
    scenario: AutomationScenario,
    processName: string,
    evidenceHash: string,
    processAllowed: boolean,
    options: InputBatchOptions = {},
  ): Promise<QaActionTrace[]> {
    if (this.killSwitch.isLatched()) this.clearQueue();
    this.refreshMinuteBudget();
    const evaluated = decision.intended.map((action, index) => {
      const safety = evaluateSafety({
        mode: this.mode,
        killSwitchLatched: this.killSwitch.isLatched(),
        dryRun: scenario.dryRun,
        processAllowed,
        moduleEnabled: scenario.enabledModules.includes(decision.module as never) || decision.module === "orchestrator",
        confidence: decision.confidence,
        confidenceThreshold: scenario.confidenceThreshold,
        actionsThisMinute: this.actionsThisMinute + index,
        actionsPerMinute: scenario.actionsPerMinute,
      });
      return {
        safety,
        trace: {
          timestamp: new Date().toISOString(),
          scenarioId: scenario.id,
          module: decision.module,
          mode: this.mode,
          processName,
          evidenceHash,
          confidence: decision.confidence,
          decisionRule: decision.rule,
          reason: `${decision.reason}; safety=${safety.reason}`,
          input: action,
          result: safety.allow ? "pending" : "blocked",
        } satisfies QaActionTrace,
      };
    });
    const allowBatch = evaluated.length > 0 && evaluated.every((entry) => entry.safety.allow);
    const produced = evaluated.map((entry) => {
      if (!allowBatch && entry.trace.result === "pending") {
        entry.trace.reason += "; batch=atomic-block";
        entry.trace.result = "blocked";
      }
      return entry.trace;
    });
    if (allowBatch) {
      try {
        if (this.sink.emitBatch) await this.sink.emitBatch(decision.intended, options);
        else for (const action of decision.intended) await this.sink.emit(action);
        this.actionsThisMinute += decision.intended.length;
        for (const trace of produced) trace.result = "emitted";
      } catch (error) {
        const reason = error instanceof Error ? error.message : "input-batch-failed";
        if (reason.startsWith("partial-input:")) {
          this.killSwitch.trip();
          this.clearQueue();
        }
        for (const trace of produced) {
          trace.result = "failed";
          trace.reason += `; sink=${reason}`;
        }
      }
    }
    this.traces.push(...produced);
    return produced;
  }
}
