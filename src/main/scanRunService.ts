import {
  assertClientPoint,
  assertScanSessionContext,
  toUtcTimestamp,
  type ScanClientPoint,
  type ScanFootprintSource,
  type ScanGridCell,
  type ScanSessionContext,
} from "../core/scanContracts.js";
import {
  cancelScan,
  createScanPlanner,
  nextScanTarget,
  recordScanObservation,
  restoreScanPlannerSnapshot,
  resumeScan,
  type ScanPlannerSnapshot,
} from "../core/scanPlanner.js";
import type {
  AutomationScenario,
  QaActionTrace,
} from "../core/types.js";
import type {
  ClipboardCopyResult,
  ClipboardCopyService,
} from "./clipboardCopyService.js";
import {
  ScanSessionStore,
  type ScanSession,
} from "./scanSessionStore.js";

export interface ScanCellPoints {
  /** Persisted 0-based client-relative point. */
  clientPoint: ScanClientPoint;
  /** Point transformed for the injected GameInputController adapter. */
  controllerPoint: { x: number; y: number };
}

export interface InterpretedScanItem {
  fingerprint?: string;
  footprint?: {
    width: number;
    height: number;
    source: ScanFootprintSource;
  };
  ruleMatched?: boolean;
  reason?: string;
}

export interface ScanRunDecision {
  at: string;
  sessionId: string;
  cell: ScanGridCell;
  kind: "empty" | "copy" | "dry-run" | "cancel";
  reason: string;
}

export interface ScanRunRequest {
  sessionId?: string;
  context: ScanSessionContext;
  scenario: AutomationScenario;
  capabilityArmed: boolean;
  processName: string;
  processAllowed: boolean;
  evidenceHash: string;
  pointForCell(cell: ScanGridCell): ScanCellPoints | Promise<ScanCellPoints>;
  occupancyAt?(
    cell: ScanGridCell,
  ): boolean | undefined | Promise<boolean | undefined>;
  interpretCopiedText?(
    text: string,
    cell: ScanGridCell,
  ): InterpretedScanItem | Promise<InterpretedScanItem>;
  acceptClipboardText?: (text: string) => boolean;
  signal?: AbortSignal;
}

export interface ScanRunResult {
  status: "finished" | "aborted" | "failed";
  reason: string;
  session: ScanSession;
  planner: ScanPlannerSnapshot;
  traces: QaActionTrace[];
}

export interface ScanRunServiceOptions {
  sessions: ScanSessionStore;
  clipboard: Pick<ClipboardCopyService, "copyHovered">;
  clock?: () => string | number | Date;
  onDecision?: (decision: ScanRunDecision) => void | Promise<void>;
  onTrace?: (trace: QaActionTrace) => void | Promise<void>;
}

function sameContext(left: ScanSessionContext, right: ScanSessionContext): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function rejectedCopyResult(result: ClipboardCopyResult): boolean {
  return result.status === "blocked" || result.status === "copy-timeout";
}

/**
 * Scanner orchestration skeleton. It owns no native adapters: all generated
 * input remains inside the injected ClipboardCopyService/GameInputController
 * path, while dry-run emits traces without invoking that path.
 */
export class ScanRunService {
  private readonly clock: () => string | number | Date;

  constructor(private readonly options: ScanRunServiceOptions) {
    this.clock = options.clock ?? (() => new Date());
  }

  private now(): string {
    return toUtcTimestamp(this.clock());
  }

  private validateRequest(request: ScanRunRequest): void {
    assertScanSessionContext(request.context);
    if (!request.capabilityArmed) throw new Error("scan-capability-not-armed");
    if (!request.scenario.enabledModules.includes("stash")) {
      throw new Error("scan-module-disabled");
    }
    if (
      request.context.source.sourceMode === "live" &&
      !request.processAllowed
    ) {
      throw new Error("scan-process-not-allowlisted");
    }
    if (!request.processName.trim()) throw new Error("scan-process-name-required");
    if (!request.evidenceHash.trim()) throw new Error("scan-evidence-hash-required");
  }

  private async decision(
    value: ScanRunDecision,
  ): Promise<void> {
    await this.options.onDecision?.(value);
  }

  private async traces(values: readonly QaActionTrace[]): Promise<void> {
    for (const trace of values) await this.options.onTrace?.(trace);
  }

  private async persistDelta(
    sessionId: string,
    priorRecordCount: number,
    planner: ScanPlannerSnapshot,
  ): Promise<void> {
    for (const record of planner.records.slice(priorRecordCount)) {
      await this.options.sessions.appendSlot(sessionId, record);
    }
    await this.options.sessions.savePlannerSnapshot(
      sessionId,
      planner,
      this.now(),
    );
  }

  private dryRunTrace(
    request: ScanRunRequest,
    point: ScanCellPoints,
    cell: ScanGridCell,
  ): QaActionTrace {
    return {
      timestamp: this.now(),
      scenarioId: request.scenario.id,
      module: "stash",
      mode: request.context.source.runtimeMode,
      processName: request.processName,
      evidenceHash: request.evidenceHash,
      confidence: 1,
      decisionRule: "scanner-dry-run",
      reason: `dry-run blocked copy at ${cell.row},${cell.col}`,
      input: {
        kind: "move",
        x: point.controllerPoint.x,
        y: point.controllerPoint.y,
      },
      result: "blocked",
    };
  }

  private async cancelActive(
    sessionId: string,
    planner: ScanPlannerSnapshot,
    reason: string,
    clientPoint?: ScanClientPoint,
  ): Promise<ScanRunResult> {
    const before = planner.records.length;
    const cancelled = cancelScan(planner, this.now(), reason, clientPoint);
    await this.persistDelta(sessionId, before, cancelled);
    const session = await this.options.sessions.abortSession(
      sessionId,
      reason,
      this.now(),
    );
    return {
      status: "aborted",
      reason,
      session,
      planner: cancelled,
      traces: [],
    };
  }

  private async loop(
    sessionId: string,
    initial: ScanPlannerSnapshot,
    request: ScanRunRequest,
  ): Promise<ScanRunResult> {
    let planner = initial;
    const allTraces: QaActionTrace[] = [];
    try {
      while (planner.phase === "active") {
        const target = nextScanTarget(planner);
        if (!target) break;
        if (request.signal?.aborted) {
          await this.decision({
            at: this.now(),
            sessionId,
            cell: target.cell,
            kind: "cancel",
            reason: "scan-abort-signal",
          });
          const result = await this.cancelActive(
            sessionId,
            planner,
            "scan-abort-signal",
          );
          return { ...result, traces: allTraces };
        }

        const points = await request.pointForCell(target.cell);
        assertClientPoint(points.clientPoint);
        if (
          !Number.isFinite(points.controllerPoint.x) ||
          !Number.isFinite(points.controllerPoint.y)
        ) {
          throw new Error("invalid-scan-controller-point");
        }
        const occupied = await request.occupancyAt?.(target.cell);
        const before = planner.records.length;
        const at = this.now();

        if (occupied === false) {
          await this.decision({
            at,
            sessionId,
            cell: target.cell,
            kind: "empty",
            reason: "perception-reported-empty",
          });
          planner = recordScanObservation(planner, {
            at,
            status: "empty",
            clientPoint: points.clientPoint,
            reason: "perception-reported-empty",
          });
        } else if (request.scenario.dryRun) {
          await this.decision({
            at,
            sessionId,
            cell: target.cell,
            kind: "dry-run",
            reason: "scenario-dry-run",
          });
          const trace = this.dryRunTrace(request, points, target.cell);
          allTraces.push(trace);
          await this.traces([trace]);
          planner = recordScanObservation(planner, {
            at,
            status: "blocked",
            clientPoint: points.clientPoint,
            reason: "scenario-dry-run",
          });
        } else {
          await this.decision({
            at,
            sessionId,
            cell: target.cell,
            kind: "copy",
            reason: "copy-cell-through-audited-controller",
          });
          const copy = await this.options.clipboard.copyHovered({
            hoverPoint: points.controllerPoint,
            hoverMs: request.context.source.timing.hoverMs,
            copyTimeoutMs: request.context.source.timing.copyTimeoutMs,
            pollIntervalMs: request.context.source.timing.pollIntervalMs,
            afterCopyMs: request.context.source.timing.afterCopyMs,
            context: {
              scenario: request.scenario,
              processName: request.processName,
              processAllowed: request.processAllowed,
              evidenceHash: request.evidenceHash,
            },
            ...(request.signal ? { signal: request.signal } : {}),
            ...(request.acceptClipboardText
              ? { acceptText: request.acceptClipboardText }
              : {}),
          });
          allTraces.push(...copy.traces);
          await this.traces(copy.traces);
          if (copy.status === "cancelled") {
            const result = await this.cancelActive(
              sessionId,
              planner,
              copy.reason,
              points.clientPoint,
            );
            return { ...result, traces: allTraces };
          }
          if (rejectedCopyResult(copy)) {
            planner = recordScanObservation(planner, {
              at,
              status: copy.status,
              clientPoint: points.clientPoint,
              reason: copy.reason,
            });
          } else {
            const text = copy.text ?? "";
            const interpreted =
              (await request.interpretCopiedText?.(text, target.cell)) ?? {};
            planner = recordScanObservation(planner, {
              at,
              status: "copied",
              clientPoint: points.clientPoint,
              rawText: text,
              ...(interpreted.fingerprint == null
                ? {}
                : { itemFingerprint: interpreted.fingerprint }),
              ...(interpreted.footprint == null
                ? {}
                : { footprint: interpreted.footprint }),
              ...(interpreted.ruleMatched == null
                ? {}
                : { ruleMatched: interpreted.ruleMatched }),
              ...(interpreted.reason == null
                ? {}
                : { reason: interpreted.reason }),
            });
          }
        }
        await this.persistDelta(sessionId, before, planner);
      }

      const session = await this.options.sessions.finishSession(
        sessionId,
        "scan-complete",
        this.now(),
      );
      return {
        status: "finished",
        reason: "scan-complete",
        session,
        planner,
        traces: allTraces,
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const session = await this.options.sessions.failSession(
        sessionId,
        error,
        "scan-run-failed",
        this.now(),
      );
      return {
        status: "failed",
        reason,
        session,
        planner,
        traces: allTraces,
      };
    }
  }

  async start(request: ScanRunRequest): Promise<ScanRunResult> {
    this.validateRequest(request);
    const planner = createScanPlanner({
      grid: request.context.grid,
      unknownSizePolicy: "scan-each-cell",
      edgePolicy: "clip",
    });
    const session = await this.options.sessions.createSession({
      ...(request.sessionId == null ? {} : { id: request.sessionId }),
      context: request.context,
      startedAt: this.now(),
    });
    await this.options.sessions.savePlannerSnapshot(
      session.id,
      planner,
      this.now(),
    );
    return this.loop(session.id, planner, request);
  }

  async resume(
    sessionId: string,
    request: ScanRunRequest,
  ): Promise<ScanRunResult> {
    this.validateRequest(request);
    const session = await this.options.sessions.getSession(sessionId);
    if (!session) throw new Error("scan-session-not-found");
    if (session.status !== "active") {
      throw new Error(`scan-session-terminal:${session.status}`);
    }
    if (!sameContext(session.context, request.context)) {
      throw new Error("scan-resume-context-mismatch");
    }
    if (!session.plannerSnapshot) {
      throw new Error("scan-resume-snapshot-required");
    }
    let planner = restoreScanPlannerSnapshot(session.plannerSnapshot);
    if (planner.phase === "cancelled") planner = resumeScan(planner);
    await this.options.sessions.resumeSession(
      sessionId,
      "resume-after-reload",
      this.now(),
    );
    await this.options.sessions.savePlannerSnapshot(
      sessionId,
      planner,
      this.now(),
    );
    return this.loop(sessionId, planner, request);
  }
}
