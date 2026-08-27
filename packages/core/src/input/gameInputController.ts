import type { Clock } from "../clock.js";
import { SystemClock } from "../clock.js";
import type { RuntimeCapabilities } from "../capabilities/createCapabilities.js";
import { createInterlockGate } from "../interlock/interlockGate.js";
import { TokenBucketRateLimiter } from "../interlock/rateLimiter.js";
import type { InterlockContext, InterlockGate, InterlockVerdict } from "../interlock/types.js";
import { createInputSink } from "./createInputSink.js";
import { EmergencyStop } from "./emergencyStop.js";
import { ForbiddenInputSink } from "./sinks/forbiddenInputSink.js";
import { hashSeed, mulberry32, timingJitterMs } from "./mulberry32.js";
import type { BotDecision, GameInputController, InputAction, InputResult, InputSink, Sleeper } from "./types.js";

export interface DecisionRecord {
  decision: BotDecision;
  verdict: InterlockVerdict;
  results: InputResult[];
}

export function createNoopSleeper(): Sleeper {
  return {
    async sleep(): Promise<void> {
      return;
    },
  };
}

export function createSystemSleeper(): Sleeper {
  return {
    sleep(ms: number): Promise<void> {
      return new Promise((resolve) => {
        setTimeout(resolve, ms);
      });
    },
  };
}

function result(
  clock: Clock,
  fields: Omit<InputResult, "startedAtMs" | "finishedAtMs">,
): InputResult {
  const startedAtMs = clock.nowMs();
  return { ...fields, startedAtMs, finishedAtMs: clock.nowMs() };
}

type QueueItem = {
  decision: BotDecision;
  ctx: InterlockContext;
  resolve: (results: InputResult[]) => void;
};

export interface CreateGameInputControllerOptions {
  capabilities: RuntimeCapabilities;
  emergencyStop?: EmergencyStop;
  clock?: Clock;
  sink?: InputSink;
  rateLimiter?: TokenBucketRateLimiter;
  gate?: InterlockGate;
  sleeper?: Sleeper;
}

export class DefaultGameInputController implements GameInputController {
  readonly sink: InputSink;
  readonly recordedActions: InputAction[] = [];
  readonly records: DecisionRecord[] = [];
  readonly rateLimiter: TokenBucketRateLimiter;
  readonly emergencyStopLatch: EmergencyStop;

  readonly #clock: Clock;
  readonly #gate: InterlockGate;
  readonly #sleeper: Sleeper;
  readonly #queue: QueueItem[] = [];
  #draining = false;

  constructor(options: CreateGameInputControllerOptions) {
    this.#clock = options.clock ?? new SystemClock();
    this.emergencyStopLatch = options.emergencyStop ?? new EmergencyStop();
    this.rateLimiter =
      options.rateLimiter ?? new TokenBucketRateLimiter(this.#clock, 30);
    this.#gate = options.gate ?? createInterlockGate({ rateLimiter: this.rateLimiter, clock: this.#clock });
    const requestedSink = options.sink ?? createInputSink(options.capabilities);
    this.sink =
      !options.capabilities.canEmitNativeInput && requestedSink.kind === "native"
        ? new ForbiddenInputSink()
        : requestedSink;
    this.#sleeper = options.sleeper ?? createNoopSleeper();
  }

  isStopped(): boolean {
    return this.emergencyStopLatch.isLatched();
  }

  emergencyStop(): void {
    this.emergencyStopLatch.trip();
    this.sink.cancel();
    this.clearQueue();
  }

  clearQueue(): void {
    const pending = this.#queue.splice(0, this.#queue.length);
    for (const item of pending) {
      const blocked = [
        result(this.#clock, {
          accepted: false,
          executed: false,
          dryRun: false,
          blockedReason: "emergency-stop",
        }),
      ];
      item.resolve(blocked);
    }
  }

  enqueue(decision: BotDecision, ctx: InterlockContext): Promise<InputResult[]> {
    if (this.emergencyStopLatch.isLatched()) {
      const blocked = [
        result(this.#clock, {
          accepted: false,
          executed: false,
          dryRun: false,
          blockedReason: "emergency-stop",
        }),
      ];
      this.records.push({
        decision,
        verdict: {
          code: "emergency-stop",
          allowExecute: false,
          allowRecord: true,
          message: "Emergency stop is latched",
        },
        results: blocked,
      });
      return Promise.resolve(blocked);
    }

    return new Promise((resolve) => {
      this.#queue.push({ decision, ctx, resolve });
      void this.#drain();
    });
  }

  async #drain(): Promise<void> {
    if (this.#draining) {
      return;
    }
    this.#draining = true;
    try {
      while (this.#queue.length > 0) {
        const item = this.#queue.shift();
        if (item === undefined) {
          break;
        }
        if (this.emergencyStopLatch.isLatched()) {
          const blocked = [
            result(this.#clock, {
              accepted: false,
              executed: false,
              dryRun: false,
              blockedReason: "emergency-stop",
            }),
          ];
          this.records.push({
            decision: item.decision,
            verdict: {
              code: "emergency-stop",
              allowExecute: false,
              allowRecord: true,
              message: "Emergency stop is latched",
            },
            results: blocked,
          });
          item.resolve(blocked);
          continue;
        }
        const results = await this.#process(item.decision, item.ctx);
        item.resolve(results);
      }
    } finally {
      this.#draining = false;
      if (this.#queue.length > 0 && !this.emergencyStopLatch.isLatched()) {
        void this.#drain();
      }
    }
  }

  async #process(decision: BotDecision, ctx: InterlockContext): Promise<InputResult[]> {
    const verdict = this.#gate.evaluate(ctx);
    if (this.emergencyStopLatch.isLatched()) {
      const blocked = [
        result(this.#clock, {
          accepted: false,
          executed: false,
          dryRun: false,
          blockedReason: "emergency-stop",
        }),
      ];
      this.records.push({ decision, verdict, results: blocked });
      return blocked;
    }

    const actions = decision.intendedActions;
    if (!verdict.allowExecute && verdict.code !== "dry-run") {
      const fallback: InputAction = { type: "noop", reason: verdict.code };
      const results = (actions.length > 0 ? actions : [fallback]).map((action) => {
        if (verdict.allowRecord) {
          this.recordedActions.push(action);
        }
        return result(this.#clock, {
          accepted: false,
          executed: false,
          dryRun: false,
          blockedReason: verdict.code,
        });
      });
      this.records.push({ decision, verdict, results });
      return results;
    }

    const rng = mulberry32(hashSeed(ctx.scenario.id, ctx.world.tickId));
    const results: InputResult[] = [];
    const planned = actions.length > 0 ? actions : [{ type: "noop" as const, reason: verdict.message }];

    for (const action of planned) {
      if (this.emergencyStopLatch.isLatched()) {
        results.push(
          result(this.#clock, {
            accepted: false,
            executed: false,
            dryRun: verdict.code === "dry-run",
            blockedReason: "emergency-stop",
          }),
        );
        break;
      }

      const jitterMs = timingJitterMs(ctx.scenario.timingProfileId, rng);
      if (jitterMs > 0) {
        await this.#sleeper.sleep(jitterMs);
      }
      if (this.emergencyStopLatch.isLatched()) {
        results.push(
          result(this.#clock, {
            accepted: false,
            executed: false,
            dryRun: verdict.code === "dry-run",
            blockedReason: "emergency-stop",
          }),
        );
        break;
      }

      if (!this.rateLimiter.tryConsume(ctx.scenario.actionsPerMinute)) {
        results.push(
          result(this.#clock, {
            accepted: false,
            executed: false,
            dryRun: verdict.code === "dry-run",
            blockedReason: "rate-limited",
          }),
        );
        continue;
      }

      if (verdict.allowRecord) {
        this.recordedActions.push(action);
      }

      if (!verdict.allowExecute) {
        results.push(
          result(this.#clock, {
            accepted: true,
            executed: false,
            dryRun: true,
          }),
        );
        continue;
      }

      const executed = await this.sink.execute(action);
      results.push(executed);
    }

    this.records.push({ decision, verdict, results });
    return results;
  }
}

export function createGameInputController(
  options: CreateGameInputControllerOptions,
): DefaultGameInputController {
  return new DefaultGameInputController(options);
}
