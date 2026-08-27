import { createHash } from "node:crypto";
import { startWinHost } from "../adapters/winHost.js";
import { WinHostInputSink } from "../adapters/winHostInputSink.js";
import {
  type BuildProfile,
} from "../core/buildProfiles.js";
import {
  activeStashGrid,
  type CalibrationProfile,
  type GridMark,
} from "../core/calibrationProfile.js";
import { RuntimeCapabilities } from "../core/capabilities.js";
import { GameInputController } from "../core/gameInputController.js";
import { matchItemToGearTarget } from "../core/gearTargetMatcher.js";
import { FakeInputSink, type InputSink } from "../core/inputSink.js";
import {
  enrichItemSize,
  type ItemSizeDatabase,
} from "../core/itemSizeStore.js";
import { KillSwitch } from "../core/killSwitch.js";
import { parseItemText } from "../core/parseItem.js";
import {
  CLIENT_RELATIVE_SCAN_SPACE,
  createScanGrid,
  type ScanGridCell,
  type ScanGridKind,
  type ScanSessionContext,
} from "../core/scanContracts.js";
import { matchCompiledRules, type CompiledScanRule } from "../core/scanRules.js";
import { scenario } from "../core/scenarios.js";
import {
  clampToRect,
  resolvePhysicalClient,
  type ScreenRect,
} from "../core/screenLayout.js";
import type {
  AutomationScenario,
  NormalizedItem,
  QaActionTrace,
  RuntimeMode,
} from "../core/types.js";
import type {
  ItemEvaluation,
  ScannerRuntimeEvent,
  ScannerRuntimeStatus,
  ScannerStartRequest,
} from "../shared/ipc.js";
import { SCANNER_IPC_VERSION } from "../shared/ipc.js";
import {
  ClipboardCopyService,
  type ClipboardTextPort,
} from "./clipboardCopyService.js";
import {
  ScanRunService,
  type ScanRunResult,
} from "./scanRunService.js";
import {
  ScanSessionStore,
  type ScanSession,
} from "./scanSessionStore.js";

export interface ScannerRuntimeServiceOptions {
  mode: RuntimeMode;
  qaOptIn: boolean;
  killSwitch: KillSwitch;
  sessions: ScanSessionStore;
  clipboard: ClipboardTextPort;
  profile: () => CalibrationProfile;
  itemSizeDatabase?: () => ItemSizeDatabase | undefined;
  rules?: (ruleSetId?: string) => CompiledScanRule[];
  buildProfile?: (profileId?: string) => BuildProfile | undefined;
  evaluateItemText?: (
    text: string,
  ) => ItemEvaluation | Promise<ItemEvaluation>;
  persistSession?: (session: ScanSession) => void | Promise<void>;
  onEvent?: (event: ScannerRuntimeEvent) => void;
  onTrace?: (trace: QaActionTrace) => void | Promise<void>;
  hostFactory?: typeof startWinHost;
}

interface PreparedTarget {
  processName: string;
  processAllowed: boolean;
  client: ScreenRect;
  sink: InputSink;
  close(): Promise<void>;
}

const DEFAULT_TIMING = {
  profile: "scanner-humanized",
  hoverMs: 35,
  copyTimeoutMs: 450,
  pollIntervalMs: 15,
  afterCopyMs: 10,
} as const;

function normalizedAllowlist(values: readonly string[]): string[] {
  return [
    ...new Set(
      values
        .map((entry) => String(entry).trim())
        .filter(Boolean),
    ),
  ];
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function markForGrid(
  profile: CalibrationProfile,
  kind: ScanGridKind,
): GridMark | undefined {
  if (kind === "inventory") return profile.bagGrid;
  if (kind === "stash-quad") return profile.quadStashGrid;
  return profile.stashGrid ?? activeStashGrid(profile);
}

function clientPointForCell(
  profile: CalibrationProfile,
  mark: GridMark,
  client: ScreenRect,
  cell: ScanGridCell,
): { x: number; y: number } {
  const scaleX = client.width / profile.client.width;
  const scaleY = client.height / profile.client.height;
  return {
    x: Math.round(
      (mark.x + ((cell.col + 0.5) * mark.w) / mark.cols) * scaleX,
    ),
    y: Math.round(
      (mark.y + ((cell.row + 0.5) * mark.h) / mark.rows) * scaleY,
    ),
  };
}

function itemFootprint(item: NormalizedItem) {
  if (!item.gridW || !item.gridH) return undefined;
  return {
    width: item.gridW,
    height: item.gridH,
    source: "fixed-class" as const,
  };
}

function summarizeMatches(
  item: NormalizedItem,
  text: string,
  rules: readonly CompiledScanRule[],
  profile: BuildProfile | undefined,
): { matched?: boolean; reason: string } {
  const ruleMatches = rules.length
    ? matchCompiledRules([...rules], text, true)
    : [];
  const buildMatches =
    profile?.gearTargets
      .map((target) => ({
        target,
        match: matchItemToGearTarget(target, item),
      }))
      .filter((entry) => entry.match.matched) ?? [];
  const hasFilter = rules.length > 0 || Boolean(profile?.gearTargets.length);
  const matched = ruleMatches.length > 0 || buildMatches.length > 0;
  const reasons = [
    ...(rules.length
      ? [
          ruleMatches.length
            ? `rules:${ruleMatches.map((rule) => rule.name).join(",")}`
            : "rules:no-match",
        ]
      : []),
    ...(profile?.gearTargets.length
      ? [
          buildMatches.length
            ? `build-targets:${buildMatches
                .map((entry) => entry.target.name)
                .join(",")}`
            : "build-targets:no-match",
        ]
      : []),
  ];
  return {
    ...(hasFilter ? { matched } : {}),
    reason: reasons.join(";") || "item-copied",
  };
}

export class ScannerRuntimeService {
  private currentAbort?: AbortController;
  private currentController?: GameInputController;
  private activeSessionId?: string;
  private lastResult?: ScannerRuntimeStatus["lastResult"];

  constructor(private readonly options: ScannerRuntimeServiceOptions) {}

  get status(): ScannerRuntimeStatus {
    return {
      schemaVersion: SCANNER_IPC_VERSION,
      running: Boolean(this.currentAbort),
      mode: this.options.mode,
      qaOptIn: this.options.qaOptIn,
      killLatched: this.options.killSwitch.isLatched(),
      ...(this.activeSessionId
        ? { activeSessionId: this.activeSessionId }
        : {}),
      ...(this.lastResult ? { lastResult: { ...this.lastResult } } : {}),
    };
  }

  private emit(
    phase: ScannerRuntimeEvent["phase"],
    message: string,
    extra: Omit<
      ScannerRuntimeEvent,
      "schemaVersion" | "at" | "phase" | "message"
    > = {},
  ): void {
    this.options.onEvent?.({
      schemaVersion: SCANNER_IPC_VERSION,
      at: new Date().toISOString(),
      phase,
      message,
      ...extra,
    });
  }

  private validateRequest(request: ScannerStartRequest): string[] {
    if (
      !["stash-normal", "stash-quad", "inventory"].includes(request.gridKind)
    ) {
      throw new Error("invalid-scanner-grid-kind");
    }
    if (typeof request.dryRun !== "boolean") {
      throw new Error("invalid-scanner-dry-run");
    }
    if (!this.options.qaOptIn) throw new Error("scanner-local-qa-opt-in-required");
    if (this.options.mode !== "authorized-qa") {
      throw new Error("authorized-qa-scanner-required");
    }
    if (this.options.killSwitch.isLatched()) {
      throw new Error("scanner-emergency-stop-latched");
    }
    const allowlist = normalizedAllowlist(request.allowlist);
    if (!allowlist.length) throw new Error("scanner-process-allowlist-required");
    const actionsPerMinute = request.actionsPerMinute ?? 240;
    if (
      !Number.isInteger(actionsPerMinute) ||
      actionsPerMinute < 1 ||
      actionsPerMinute > 1_200
    ) {
      throw new Error("invalid-scanner-actions-per-minute");
    }
    return allowlist;
  }

  private capabilities(
    request: ScannerStartRequest,
    allowlist: string[],
  ): RuntimeCapabilities {
    return new RuntimeCapabilities({
      mode: this.options.mode,
      buildAllowsQa: true,
      qaAcknowledged: request.qaAcknowledged,
      assistiveAcknowledged: false,
      allowlist,
      bannerVisible: true,
      emergencyStopRegistered: true,
    });
  }

  private async prepareTarget(
    request: ScannerStartRequest,
    allowlist: string[],
    capabilities: RuntimeCapabilities,
    profile: CalibrationProfile,
    mark: GridMark,
  ): Promise<PreparedTarget> {
    if (request.dryRun) {
      const processName = allowlist[0]!;
      return {
        processName,
        processAllowed: capabilities.isProcessAllowed(processName),
        client: {
          left: 0,
          top: 0,
          width: profile.client.width,
          height: profile.client.height,
        },
        sink: new FakeInputSink(),
        close: async () => undefined,
      };
    }

    const host = (this.options.hostFactory ?? startWinHost)();
    try {
      const target = await host.send({ op: "rect" });
      if (!target.ok) {
        throw new Error(String(target.error ?? "target-window-missing"));
      }
      if (!String(target.hwnd ?? "").trim()) {
        throw new Error("target-window-unpinned");
      }
      const process = String(target.process ?? "").trim();
      const processName = /\.exe$/i.test(process) ? process : `${process}.exe`;
      const processAllowed = capabilities.isProcessAllowed(processName);
      if (!processAllowed) throw new Error("scanner-process-not-allowlisted");
      const client = resolvePhysicalClient(
        {
          left: Number(target.left),
          top: Number(target.top),
          width: Number(target.width),
          height: Number(target.height),
        },
        Number(target.monitorWidth) || Number(target.width),
        Number(target.monitorHeight) || Number(target.height),
        {
          left: Number(target.monitorLeft ?? target.left ?? 0),
          top: Number(target.monitorTop ?? target.top ?? 0),
        },
      );
      const gridTopLeft = clientPointForCell(
        profile,
        mark,
        client,
        { row: 0, col: 0 },
      );
      const gridBottomRight = clientPointForCell(
        profile,
        mark,
        client,
        { row: mark.rows - 1, col: mark.cols - 1 },
      );
      const sink = new WinHostInputSink(host, {
        allowedProcesses: allowlist,
        requireForeground: true,
        actionGuard: (action) => {
          if (action.kind !== "move") return { ok: action.kind === "key" };
          const insideClient = clampToRect(
            Number(action.x),
            Number(action.y),
            client,
            0,
          );
          const insideGrid =
            Number(action.x) >= client.left + gridTopLeft.x - 2 &&
            Number(action.x) <= client.left + gridBottomRight.x + 2 &&
            Number(action.y) >= client.top + gridTopLeft.y - 2 &&
            Number(action.y) <= client.top + gridBottomRight.y + 2;
          return {
            ok: Boolean(insideClient && insideGrid),
            ...(insideGrid ? {} : { reason: "scanner-point-outside-grid" }),
          };
        },
      });
      return {
        processName,
        processAllowed,
        client,
        sink,
        close: () => host.close(),
      };
    } catch (error) {
      await host.close();
      throw error;
    }
  }

  async start(request: ScannerStartRequest): Promise<ScanRunResult> {
    if (this.currentAbort) throw new Error("scanner-already-running");
    const allowlist = this.validateRequest(request);
    const capabilities = this.capabilities(request, allowlist);
    if (!capabilities.canArmAutomation()) {
      throw new Error("scanner-capability-not-armed");
    }
    const profile = this.options.profile();
    const grid = createScanGrid(request.gridKind);
    const mark = markForGrid(profile, request.gridKind);
    if (
      !mark ||
      mark.cols !== grid.cols ||
      mark.rows !== grid.rows ||
      mark.w <= 0 ||
      mark.h <= 0
    ) {
      throw new Error(`scanner-calibration-required:${request.gridKind}`);
    }
    const rules = this.options.rules?.(request.ruleSetId) ?? [];
    const buildProfile = this.options.buildProfile?.(request.profileId);
    const target = await this.prepareTarget(
      request,
      allowlist,
      capabilities,
      profile,
      mark,
    );
    const abort = new AbortController();
    this.currentAbort = abort;
    const runScenario: AutomationScenario = scenario({
      id: `scanner-${request.gridKind}`,
      name: `Scanner ${request.gridKind}`,
      enabledModules: ["stash"],
      dryRun: request.dryRun,
      actionsPerMinute: request.actionsPerMinute ?? 240,
      confidenceThreshold: 0.8,
      timingProfile: "humanized",
    });
    const timing = {
      ...DEFAULT_TIMING,
      ...request.timing,
    };
    const context: ScanSessionContext = {
      coordinateSpace: { ...CLIENT_RELATIVE_SCAN_SPACE },
      grid,
      source: {
        sourceMode: request.dryRun ? "fixture" : "live",
        runtimeMode: this.options.mode,
        profileId: request.profileId ?? "calibration-current",
        calibrationHash: hash(profile),
        ruleHash: hash(rules),
        timing: {
          ...timing,
          randomized: !request.dryRun,
          ...(request.dryRun ? { seed: "dry-run" } : {}),
        },
      },
    };
    const controller = new GameInputController(
      target.sink,
      this.options.killSwitch,
      this.options.mode,
    );
    this.currentController = controller;
    const clipboard = new ClipboardCopyService({
      input: controller,
      clipboard: this.options.clipboard,
    });
    const runner = new ScanRunService({
      sessions: this.options.sessions,
      clipboard,
      onDecision: (decision) => {
        this.activeSessionId = decision.sessionId;
        this.emit("decision", decision.reason, {
          sessionId: decision.sessionId,
          cell: decision.cell,
        });
      },
      onTrace: async (trace) => {
        await this.options.onTrace?.(trace);
        this.emit("trace", trace.reason, { result: trace.result });
      },
    });
    this.emit("start", `${request.gridKind}:${request.dryRun ? "dry-run" : "live"}`);
    try {
      const result = await runner.start({
        context,
        scenario: runScenario,
        capabilityArmed: true,
        processName: target.processName,
        processAllowed: target.processAllowed,
        evidenceHash: hash({
          calibrationHash: context.source.calibrationHash,
          ruleHash: context.source.ruleHash,
          grid,
        }),
        pointForCell: (cell) => {
          const clientPoint = clientPointForCell(profile, mark, target.client, cell);
          return {
            clientPoint,
            controllerPoint: {
              x: target.client.left + clientPoint.x,
              y: target.client.top + clientPoint.y,
            },
          };
        },
        interpretCopiedText: async (text) => {
          const evaluation = await this.options.evaluateItemText?.(text);
          const parsed = parseItemText(text);
          const itemSizeDatabase = this.options.itemSizeDatabase?.();
          const item =
            evaluation?.parsed === true
              ? evaluation.item
              : itemSizeDatabase
                ? enrichItemSize(parsed, itemSizeDatabase)
                : parsed;
          const matches = summarizeMatches(item, text, rules, buildProfile);
          return {
            fingerprint: item.fingerprint,
            ...(itemFootprint(item)
              ? { footprint: itemFootprint(item) }
              : {}),
            ...(matches.matched == null
              ? {}
              : { ruleMatched: matches.matched }),
            reason: matches.reason,
          };
        },
        signal: abort.signal,
      });
      this.activeSessionId = result.session.id;
      this.lastResult = {
        status: result.status,
        reason: result.reason,
        sessionId: result.session.id,
        records: result.session.slots.length,
      };
      await this.options.persistSession?.(result.session);
      this.emit("complete", result.reason, {
        sessionId: result.session.id,
        result: result.status,
      });
      return result;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "scanner-runtime-failed";
      this.emit("error", message, {
        ...(this.activeSessionId
          ? { sessionId: this.activeSessionId }
          : {}),
      });
      throw error;
    } finally {
      controller.clearQueue();
      await target.close();
      this.currentAbort = undefined;
      this.currentController = undefined;
      this.activeSessionId = undefined;
    }
  }

  stop(reason = "operator-stop"): ScannerRuntimeStatus {
    this.currentAbort?.abort(reason);
    this.currentController?.clearQueue();
    this.emit("stop", reason, {
      ...(this.activeSessionId ? { sessionId: this.activeSessionId } : {}),
    });
    return this.status;
  }
}
