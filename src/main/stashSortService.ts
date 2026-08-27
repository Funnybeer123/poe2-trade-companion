import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { bgrToGray, readBmpBgr } from "../adapters/bmp.js";
import { startWinHost } from "../adapters/winHost.js";
import { WinHostInputSink } from "../adapters/winHostInputSink.js";
import {
  activeStashGrid,
  cropClientBox,
  profileReadyForDeposit,
  type CalibrationProfile,
} from "../core/calibrationProfile.js";
import { RuntimeCapabilities } from "../core/capabilities.js";
import { STASH_SCAN } from "../core/copyTiming.js";
import { GameInputController } from "../core/gameInputController.js";
import { downsample, type GrayImage } from "../core/grayImage.js";
import {
  classDefaultSize,
  isFixedItemClass,
  loadItemSizeDatabase,
  sizeKey,
  type GridSize,
  type ItemSizeDatabase,
} from "../core/itemSizeStore.js";
import { KillSwitch } from "../core/killSwitch.js";
import { looksLikePoeItemText, parseItemText } from "../core/parseItem.js";
import { resolvePhysicalClient, type ScreenRect } from "../core/screenLayout.js";
import { scenario } from "../core/scenarios.js";
import {
  buildSortMoveSchedule,
  planStashSort,
  sortRectCells,
  stashSortSnapshotHash,
  type SortBagState,
  type SortCell,
  type SortFootprintSource,
  type SortMoveSchedule,
  type SortMoveStep,
  type SortScanIssue,
  type SortTabDescriptor,
  type SortableStashItem,
  type StashSortPlan,
} from "../core/stashSort.js";
import {
  executeStashSort,
  type SortExecutionSnapshot,
} from "../core/stashSortExecutor.js";
import type {
  AutomationScenario,
  BotDecision,
  QaActionTrace,
  RuntimeMode,
} from "../core/types.js";
import { validateTransferInput } from "../core/transferInputGuard.js";
import { perceiveUi, type UiFacts } from "../core/uiPerception.js";

export type SortStashAction = "preview" | "execute";
export type SortTabSafety = "writable-grid" | "remove-only" | "special" | "unknown";

export interface SortStashRequest {
  action: SortStashAction;
  planId?: string;
  qaAcknowledged: boolean;
  allowlist: string[];
  actionsPerMinute?: number;
  tabSafety: SortTabSafety;
}

export interface SortStashEvent {
  at: string;
  phase: string;
  message: string;
  itemCount?: number;
  completedMoves?: number;
  totalMoves?: number;
  artifact?: string;
}

export interface SortStashResult {
  ok: boolean;
  reason: string;
  action: SortStashAction;
  dryRun: boolean;
  plan: StashSortPlan;
  schedule: SortMoveSchedule;
  traces: QaActionTrace[];
}

export interface TrustedSortFootprint extends GridSize {
  source: SortFootprintSource;
}

interface StashSortServiceOptions {
  mode: RuntimeMode;
  qaOptIn: boolean;
  killSwitch: KillSwitch;
  artifactDir: string;
  profile: () => CalibrationProfile;
  onEvent?: (event: SortStashEvent) => void;
  hostFactory?: typeof startWinHost;
  sizeDatabase?: () => ItemSizeDatabase;
}

interface SortCapture {
  facts: UiFacts;
  client: ScreenRect;
  evidenceHash: string;
  bmpPath: string;
  previewPath: string;
  foreground: boolean;
  tabVisualHash: string;
}

interface SortRunContext {
  host: ReturnType<typeof startWinHost>;
  controller: GameInputController;
  scenario: AutomationScenario;
  processName: string;
  processAllowed: boolean;
  targetHwnd: string;
  profile: CalibrationProfile;
  abort: AbortController;
  lastCapture?: SortCapture;
}

interface SortScan {
  capture: SortCapture;
  tab: SortTabDescriptor;
  items: SortableStashItem[];
  issues: SortScanIssue[];
  occupiedStash: SortCell[];
  bag: SortBagState;
}

interface PreviewSession {
  plan: StashSortPlan;
  schedule: SortMoveSchedule;
  targetHwnd: string;
  bagSignature: string;
}

const MAX_SCAN_CELLS = 576;
const COPY_TIMING = STASH_SCAN.quad;

function now(): string {
  return new Date().toISOString();
}

function cellKey(cell: SortCell): string {
  return `${cell.row},${cell.col}`;
}

function cellSignature(cells: SortCell[]): string {
  return [...cells]
    .sort((a, b) => a.row - b.row || a.col - b.col)
    .map(cellKey)
    .join("|");
}

function normalizeProcess(value: unknown): string {
  const process = String(value ?? "PathOfExile");
  return /\.exe$/i.test(process) ? process : `${process}.exe`;
}

function validateRequest(request: SortStashRequest): void {
  if (request.action !== "preview" && request.action !== "execute") {
    throw new Error("invalid-sort-action");
  }
  if (!Array.isArray(request.allowlist) || !request.allowlist.some((entry) => String(entry).trim())) {
    throw new Error("process-allowlist-required");
  }
  if (!["writable-grid", "remove-only", "special", "unknown"].includes(request.tabSafety)) {
    throw new Error("invalid-tab-safety");
  }
  if (
    request.actionsPerMinute != null &&
    (!Number.isFinite(request.actionsPerMinute) ||
      request.actionsPerMinute < 1 ||
      request.actionsPerMinute > 1_200)
  ) {
    throw new Error("invalid-actions-per-minute");
  }
  if (request.action === "execute" && !request.planId?.trim()) {
    throw new Error("preview-plan-required");
  }
}

export function trustedSortFootprint(
  db: ItemSizeDatabase,
  item: Pick<ReturnType<typeof parseItemText>, "baseType" | "itemClass">,
): TrustedSortFootprint | undefined {
  const base = db.records.find(
    (record) =>
      record.kind === "baseType" &&
      record.source === "measured" &&
      record.samples >= 1 &&
      record.key === sizeKey(item.baseType),
  );
  if (base) return { w: base.w, h: base.h, source: "measured-base" };
  if (!isFixedItemClass(item.itemClass)) return undefined;
  const fixed = classDefaultSize(item.itemClass);
  return fixed ? { ...fixed, source: "fixed-class" } : undefined;
}

export function locateSortFootprint(
  hovered: SortCell,
  footprint: GridSize,
  occupied: Set<string>,
  claimed: Set<string>,
  cols: number,
  rows: number,
): SortCell | undefined {
  const candidates: SortCell[] = [];
  for (let row = hovered.row - footprint.h + 1; row <= hovered.row; row += 1) {
    for (let col = hovered.col - footprint.w + 1; col <= hovered.col; col += 1) {
      const origin = { row, col };
      const cells = sortRectCells(origin, footprint.w, footprint.h);
      if (
        cells.every(
          (cell) =>
            cell.row >= 0 &&
            cell.col >= 0 &&
            cell.row < rows &&
            cell.col < cols &&
            occupied.has(cellKey(cell)) &&
            !claimed.has(cellKey(cell)),
        )
      ) {
        candidates.push(origin);
      }
    }
  }
  if (candidates.length !== 1) return undefined;
  return candidates[0];
}

function tabDescriptor(
  profile: CalibrationProfile,
  targetHwnd: string,
  safety: SortTabSafety,
  tabVisualHash: string,
): SortTabDescriptor {
  const grid = activeStashGrid(profile);
  const kind = profile.activeStashTab === "quad" ? "quad" : "normal";
  const supported =
    Boolean(grid) &&
    ((kind === "normal" && grid!.cols === 12 && grid!.rows === 12) ||
      (kind === "quad" && grid!.cols === 24 && grid!.rows === 24));
  return {
    signature: grid
      ? createHash("sha256")
          .update(
            [
              targetHwnd,
              kind,
              grid.cols,
              grid.rows,
              grid.x,
              grid.y,
              grid.w,
              grid.h,
              tabVisualHash,
            ].join(":"),
          )
          .digest("hex")
          .slice(0, 24)
      : "",
    label: kind === "quad" ? "Calibrated quad grid" : "Calibrated normal grid",
    kind: supported ? kind : "unsupported",
    cols: grid?.cols ?? 0,
    rows: grid?.rows ?? 0,
    writable: safety === "writable-grid",
    removeOnly: safety === "remove-only",
    special: safety === "special",
  };
}

function activeTabVisualHash(
  frame: GrayImage,
  client: ScreenRect,
  profile: CalibrationProfile,
): string {
  const grid = activeStashGrid(profile);
  if (!grid) return "";
  const height = Math.max(12, Math.min(96, grid.y));
  const band = cropClientBox(frame, client, {
    x: grid.x,
    y: Math.max(0, grid.y - height),
    w: grid.w,
    h: height,
  });
  const sample = downsample(band, 64, 12);
  return createHash("sha256")
    .update(Buffer.from(sample.pixels.map((value) => Math.round(value / 16))))
    .digest("hex")
    .slice(0, 20);
}

export class StashSortService {
  private running = false;
  private currentAbort?: AbortController;
  private preview?: PreviewSession;
  private last?: SortStashResult;

  constructor(private readonly options: StashSortServiceOptions) {
    mkdirSync(options.artifactDir, { recursive: true });
  }

  get status() {
    const profile = this.options.profile();
    return {
      running: this.running,
      mode: this.options.mode,
      qaOptIn: this.options.qaOptIn,
      killLatched: this.options.killSwitch.isLatched(),
      stashTab: profile.activeStashTab === "quad" ? "quad" as const : "normal" as const,
      calibrated: profileReadyForDeposit(profile) && Boolean(profile.stashSearch),
      previewPlanId: this.preview?.plan.id,
      last: this.last,
    };
  }

  stop(reason = "operator-stop"): void {
    this.currentAbort?.abort(reason);
    this.options.killSwitch.trip();
    this.emit("stopped", reason);
  }

  async start(request: SortStashRequest): Promise<SortStashResult> {
    validateRequest(request);
    if (this.running) throw new Error("stash-sort-already-running");
    if (this.options.mode !== "authorized-qa") throw new Error("authorized-qa-build-required");
    if (!this.options.qaOptIn) throw new Error("qa-local-opt-in-required");
    if (!request.qaAcknowledged) throw new Error("qa-acknowledgement-required");
    if (this.options.killSwitch.isLatched()) throw new Error("kill-switch-latched");

    const abort = new AbortController();
    this.currentAbort = abort;
    this.running = true;
    try {
      const result =
        request.action === "preview"
          ? await this.previewSort(request, abort)
          : await this.executeSort(request, abort);
      this.last = result;
      return result;
    } catch (error) {
      this.emit("aborted", error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      this.running = false;
      this.currentAbort = undefined;
    }
  }

  private emit(phase: string, message: string, extra: Partial<SortStashEvent> = {}): void {
    this.options.onEvent?.({ at: now(), phase, message, ...extra });
  }

  private appendTrace(entries: unknown[]): void {
    if (entries.length === 0) return;
    const file = path.join(this.options.artifactDir, "stash-sort-trace.jsonl");
    appendFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  }

  private async createContext(
    request: SortStashRequest,
    abort: AbortController,
    expectedHwnd?: string,
  ): Promise<{ ctx: SortRunContext; close: () => Promise<void> }> {
    const profile = this.options.profile();
    if (!profileReadyForDeposit(profile) || !profile.stashSearch) {
      throw new Error("stash-bag-search-calibration-required");
    }
    const host = (this.options.hostFactory ?? startWinHost)();
    try {
      const target = await host.send({ op: "rect", ...(expectedHwnd ? { expectedHwnd } : {}) });
      if (!target.ok) throw new Error(String(target.error ?? "target-window-missing"));
      const targetHwnd = String(target.hwnd ?? "").trim();
      if (!targetHwnd) throw new Error("target-window-unpinned");
      if (expectedHwnd && targetHwnd !== expectedHwnd) throw new Error("target-window-changed");
      const processName = normalizeProcess(target.process);
      const capabilities = new RuntimeCapabilities({
        mode: this.options.mode,
        buildAllowsQa: true,
        qaAcknowledged: request.qaAcknowledged,
        assistiveAcknowledged: false,
        allowlist: request.allowlist,
        bannerVisible: true,
        emergencyStopRegistered: true,
      });
      const processAllowed = capabilities.isProcessAllowed(processName);
      if (!processAllowed) throw new Error("process-not-allowlisted");

      let ctx: SortRunContext | undefined;
      const sink = new WinHostInputSink(host, {
        allowedProcesses: request.allowlist,
        requireForeground: true,
        actionGuard: (action) => {
          if (action.kind !== "click" && action.kind !== "move" && action.kind !== "drag") {
            return { ok: true };
          }
          if (!ctx?.lastCapture) return { ok: false, reason: "coordinate-input-before-capture" };
          return validateTransferInput([action], profile, ctx.lastCapture.client);
        },
      });
      const runScenario = scenario({
        id: `stash-sort-${request.action}`,
        name: `Stash sort ${request.action}`,
        enabledModules: ["stash"],
        dryRun: false,
        actionsPerMinute: request.actionsPerMinute ?? 600,
        confidenceThreshold: 0.9,
        timingProfile: "tight",
      });
      ctx = {
        host,
        controller: new GameInputController(sink, this.options.killSwitch, this.options.mode),
        scenario: runScenario,
        processName,
        processAllowed,
        targetHwnd,
        profile,
        abort,
      };
      return { ctx, close: () => host.close() };
    } catch (error) {
      await host.close();
      throw error;
    }
  }

  private async previewSort(
    request: SortStashRequest,
    abort: AbortController,
  ): Promise<SortStashResult> {
    this.preview = undefined;
    const { ctx, close } = await this.createContext(request, abort);
    try {
      await this.focus(ctx, "focus the pinned test target for a metadata-only stash scan");
      const initial = await this.capture(ctx, "sort-preview-initial");
      const scan = await this.scan(ctx, initial, request.tabSafety);
      let plan = planStashSort({
        tab: scan.tab,
        items: scan.items,
        observedOccupied: scan.occupiedStash,
        scanIssues: scan.issues,
      });
      let schedule = buildSortMoveSchedule(plan, scan.bag);
      if (plan.executable && !schedule.ok) {
        const issue: SortScanIssue = {
          code: schedule.reason,
          message:
            schedule.reason === "insufficient-bag-staging-capacity"
              ? "The current bag does not have enough verified contiguous staging space to resolve stash move dependencies."
              : `A safe move schedule could not be generated: ${schedule.reason}.`,
          blocking: true,
        };
        plan = { ...plan, blockers: [...plan.blockers, issue], executable: false };
        schedule = { ...schedule, steps: [] };
      }
      this.appendTrace([{
        timestamp: now(),
        type: "decision",
        scenarioId: "stash-sort-preview",
        module: "stash",
        mode: this.options.mode,
        evidenceHash: scan.capture.evidenceHash,
        decisionRule: "deterministic-exact-base-group-packing",
        reason: plan.blockers[0]?.code ?? "preview-ready",
        planId: plan.id,
        executable: plan.executable,
        diagnostics: plan.diagnostics,
        groups: plan.groups.map((group) => ({
          itemClass: group.itemClass,
          baseType: group.baseType,
          count: group.itemIds.length,
          bounds: group.bounds,
        })),
        blockers: plan.blockers.map((blocker) => blocker.code),
        moveSteps: schedule.steps.length,
      }]);
      this.preview = plan.executable
        ? {
            plan,
            schedule,
            targetHwnd: ctx.targetHwnd,
            bagSignature: cellSignature(scan.bag.occupied),
          }
        : undefined;
      const result: SortStashResult = {
        ok: plan.blockers.length === 0,
        reason: plan.blockers[0]?.code ?? "preview-ready",
        action: "preview",
        dryRun: true,
        plan,
        schedule,
        traces: ctx.controller.actionTraces,
      };
      this.emit("preview", result.reason, {
        itemCount: plan.placements.length,
        totalMoves: schedule.steps.length,
      });
      return result;
    } finally {
      await close();
    }
  }

  private async executeSort(
    request: SortStashRequest,
    abort: AbortController,
  ): Promise<SortStashResult> {
    const preview = this.preview;
    if (!preview || preview.plan.id !== request.planId) throw new Error("stale-or-missing-preview-plan");
    this.preview = undefined;
    if (request.tabSafety !== "writable-grid") throw new Error("writable-grid-confirmation-required");
    const { ctx, close } = await this.createContext(request, abort, preview.targetHwnd);
    try {
      await this.focus(ctx, "focus the pinned test target before explicit stash-sort execution");
      const initial = await this.capture(ctx, "sort-execute-rescan");
      const scan = await this.scan(ctx, initial, request.tabSafety);
      const currentHash = stashSortSnapshotHash(scan.tab, scan.items, scan.occupiedStash);
      if (
        currentHash !== preview.plan.snapshotHash ||
        scan.tab.signature !== preview.plan.tab.signature ||
        cellSignature(scan.bag.occupied) !== preview.bagSignature
      ) {
        throw new Error("stale-plan");
      }
      const schedule = buildSortMoveSchedule(preview.plan, scan.bag);
      if (!schedule.ok) throw new Error(schedule.reason);
      const expectedSchedule = JSON.stringify(
        preview.schedule.steps.map((step) => [step.itemId, step.kind, step.from, step.to]),
      );
      const currentSchedule = JSON.stringify(
        schedule.steps.map((step) => [step.itemId, step.kind, step.from, step.to]),
      );
      if (currentSchedule !== expectedSchedule) throw new Error("stale-move-schedule");
      this.appendTrace([{
        timestamp: now(),
        type: "decision",
        scenarioId: "stash-sort-execute",
        module: "stash",
        mode: this.options.mode,
        evidenceHash: scan.capture.evidenceHash,
        decisionRule: "stale-plan-and-bounded-staging-preflight",
        reason: "explicit execution accepted after exact rescan",
        planId: preview.plan.id,
        moveSteps: schedule.steps.length,
        peakStagedItems: schedule.peakStagedItems,
        peakStagedCells: schedule.peakStagedCells,
      }]);

      let cachedPreflight: SortExecutionSnapshot | undefined = this.snapshotFromScan(
        scan,
        preview.plan.snapshotHash,
      );
      let lastStep: SortMoveStep | undefined;
      const execution = await executeStashSort(
        preview.plan,
        schedule,
        scan.bag,
        {
          capture: async (phase) => {
            if (cachedPreflight) {
              const value = cachedPreflight;
              cachedPreflight = undefined;
              return value;
            }
            const capture = await this.capture(ctx, phase);
            const identifiedItems = [];
            let heldItem: SortExecutionSnapshot["heldItem"] = "none";
            if (lastStep) {
              const placement = preview.plan.placements.find((item) => item.id === lastStep!.itemId);
              if (!placement) {
                heldItem = "unknown";
              } else {
                const point = this.itemCenter(capture, lastStep.toArea, lastStep.to, lastStep.toW, lastStep.toH);
                const text = await this.copyHoveredItem(ctx, capture, point.x, point.y);
                const parsed = looksLikePoeItemText(text) ? parseItemText(text) : undefined;
                if (
                  parsed &&
                  parsed.fingerprint === placement.fingerprint &&
                  sizeKey(parsed.baseType) === sizeKey(placement.baseType)
                ) {
                  identifiedItems.push({
                    itemId: placement.id,
                    area: lastStep.toArea,
                    position: { ...lastStep.to },
                  });
                } else {
                  heldItem = "unknown";
                }
              }
            }
            const foreground = await this.foreground(ctx);
            return {
              evidenceHash: capture.evidenceHash,
              tabSignature: tabDescriptor(
                ctx.profile,
                ctx.targetHwnd,
                request.tabSafety,
                capture.tabVisualHash,
              ).signature,
              stable:
                capture.facts.stashPanelOpen &&
                capture.facts.inventoryPanelOpen &&
                capture.facts.confidence >= 0.9,
              foreground,
              heldItem,
              occupiedStash: capture.facts.occupiedStash,
              occupiedBag: capture.facts.occupiedBag,
              identifiedItems,
            };
          },
          move: async (step, evidenceHash) => {
            const from = this.itemCenter(
              ctx.lastCapture!,
              step.fromArea,
              step.from,
              step.fromW,
              step.fromH,
            );
            const to = this.itemCenter(
              ctx.lastCapture!,
              step.toArea,
              step.to,
              step.toW,
              step.toH,
            );
            await this.execute(ctx, {
              module: "stash",
              rule: "footprint-verified-stash-sort-move",
              reason:
                `${step.kind} ${step.itemId}; target ${step.to.row},${step.to.col} ` +
                `${step.toW}x${step.toH}; evidence=${evidenceHash}`,
              confidence: ctx.lastCapture?.facts.confidence ?? 0,
              intended: [{ kind: "drag", x: from.x, y: from.y, x2: to.x, y2: to.y }],
            });
            lastStep = step;
            await new Promise<void>((resolve) => setTimeout(resolve, 140));
            this.emit("move", `${step.index + 1}/${schedule.steps.length} ${step.kind}`, {
              completedMoves: step.index + 1,
              totalMoves: schedule.steps.length,
            });
          },
        },
        {
          cancelled: () => abort.signal.aborted,
          killSwitchLatched: () => this.options.killSwitch.isLatched(),
        },
      );
      const result: SortStashResult = {
        ok: execution.ok,
        reason: execution.reason,
        action: "execute",
        dryRun: false,
        plan: preview.plan,
        schedule,
        traces: ctx.controller.actionTraces,
      };
      this.emit(execution.ok ? "complete" : "aborted", execution.reason, {
        completedMoves: execution.completedSteps,
        totalMoves: execution.totalSteps,
      });
      return result;
    } finally {
      await close();
    }
  }

  private snapshotFromScan(scan: SortScan, planSnapshotHash: string): SortExecutionSnapshot {
    return {
      evidenceHash: scan.capture.evidenceHash,
      tabSignature: scan.tab.signature,
      stable:
        scan.capture.facts.stashPanelOpen &&
        scan.capture.facts.inventoryPanelOpen &&
        scan.capture.facts.confidence >= 0.9,
      foreground: scan.capture.foreground,
      heldItem: "none",
      occupiedStash: scan.capture.facts.occupiedStash,
      occupiedBag: scan.capture.facts.occupiedBag,
      identifiedItems: [],
      planSnapshotHash,
    };
  }

  private async focus(ctx: SortRunContext, reason: string): Promise<void> {
    const traces = await this.execute(ctx, {
      module: "stash",
      rule: "pin-target-window",
      reason,
      confidence: 1,
      intended: [{ kind: "focus" }],
    });
    if (!traces.every((trace) => trace.result === "emitted")) throw new Error("target-focus-failed");
  }

  private async execute(ctx: SortRunContext, decision: BotDecision): Promise<QaActionTrace[]> {
    if (ctx.abort.signal.aborted) throw new Error("cancelled");
    const traces = await ctx.controller.execute(
      decision,
      ctx.scenario,
      ctx.processName,
      ctx.lastCapture?.evidenceHash ?? "pre-capture",
      ctx.processAllowed,
    );
    this.appendTrace(traces);
    const rejected = traces.find((trace) => trace.result !== "emitted");
    if (rejected) throw new Error(`input-${rejected.result}:${rejected.reason}`);
    return traces;
  }

  private async foreground(ctx: SortRunContext): Promise<boolean> {
    const state = await ctx.host.send({ op: "rect", expectedHwnd: ctx.targetHwnd });
    return Boolean(state.ok && state.foregroundIsPoe);
  }

  private async capture(ctx: SortRunContext, phase: string): Promise<SortCapture> {
    if (ctx.abort.signal.aborted) throw new Error("cancelled");
    if (this.options.killSwitch.isLatched()) throw new Error("kill-switch-latched");
    const rect = await ctx.host.send({ op: "rect", expectedHwnd: ctx.targetHwnd });
    if (!rect.ok) throw new Error(String(rect.error ?? "target-window-missing"));
    const id = `stash-sort-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const bmpPath = path.join(this.options.artifactDir, `${id}.bmp`);
    const previewPath = path.join(this.options.artifactDir, `${id}.png`);
    const captured = await ctx.host.send({
      op: "capture",
      path: bmpPath,
      previewPath,
      expectedHwnd: ctx.targetHwnd,
      requireForeground: true,
    });
    if (!captured.ok) throw new Error(String(captured.error ?? "capture-failed"));
    const client = resolvePhysicalClient(
      {
        left: Number(captured.left),
        top: Number(captured.top),
        width: Number(captured.width),
        height: Number(captured.height),
      },
      Number(rect.monitorWidth) || Number(captured.width),
      Number(rect.monitorHeight) || Number(captured.height),
      {
        left: Number(rect.monitorLeft ?? captured.left ?? 0),
        top: Number(rect.monitorTop ?? captured.top ?? 0),
      },
    );
    const bgr = readBmpBgr(bmpPath);
    const frame = bgrToGray(bgr);
    const facts = perceiveUi(frame, client, {}, ctx.profile, bgr);
    const evidenceHash = createHash("sha256")
      .update(
        JSON.stringify({
          stash: facts.occupiedStash.map((cell) => [cell.row, cell.col]),
          bag: facts.occupiedBag.map((cell) => [cell.row, cell.col]),
          reason: facts.reason,
          grid: facts.stashGridSize,
        }),
      )
      .digest("hex");
    const next = {
      facts,
      client,
      evidenceHash,
      bmpPath,
      previewPath,
      foreground: Boolean(rect.foregroundIsPoe),
      tabVisualHash: activeTabVisualHash(frame, client, ctx.profile),
    };
    ctx.lastCapture = next;
    this.appendTrace([{
      timestamp: now(),
      type: "perception",
      module: "stash-sort",
      phase,
      evidenceHash,
      confidence: facts.confidence,
      reason: facts.reason,
      stashCells: facts.occupiedStash.length,
      bagCells: facts.occupiedBag.length,
    }]);
    this.emit("capture", phase, { artifact: previewPath });
    return next;
  }

  private async parkCursor(ctx: SortRunContext, capture: SortCapture): Promise<void> {
    const box = ctx.profile.stashSearch;
    if (!box) throw new Error("stash-search-calibration-required");
    await this.execute(ctx, {
      module: "stash",
      rule: "sort-perception-cursor-park",
      reason: "park cursor outside item grids before stable reconciliation",
      confidence: capture.facts.confidence,
      intended: [{
        kind: "move",
        x: Math.round(capture.client.left + box.x + box.w / 2),
        y: Math.round(capture.client.top + box.y + box.h / 2),
      }],
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }

  private async copyHoveredItem(
    ctx: SortRunContext,
    capture: SortCapture,
    x: number,
    y: number,
  ): Promise<string> {
    const original = await ctx.host.send({ op: "clipboard" });
    if (!original.ok) throw new Error(String(original.error ?? "clipboard-read-failed"));
    const originalText = String(original.text ?? "");
    const sentinel = `poe2-stash-sort-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    try {
      await this.execute(ctx, {
        module: "stash",
        rule: "exact-base-clipboard-scan",
        reason: "hover a bounded occupied cell for exact base identification",
        confidence: capture.facts.confidence,
        intended: [{ kind: "move", x, y }],
      });
      await new Promise<void>((resolve) => setTimeout(resolve, COPY_TIMING.hoverMs));
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const cleared = await ctx.host.send({ op: "setclipboard", text: sentinel });
        if (!cleared.ok) throw new Error(String(cleared.error ?? "clipboard-write-failed"));
        await this.execute(ctx, {
          module: "stash",
          rule: "exact-base-clipboard-scan",
          reason: `copy hovered stash item metadata attempt ${attempt + 1}`,
          confidence: capture.facts.confidence,
          intended: [{ kind: "key", key: "ctrl+c" }],
        });
        await new Promise<void>((resolve) =>
          setTimeout(resolve, attempt === 0 ? COPY_TIMING.copyMs + 20 : COPY_TIMING.afterMs + 30),
        );
        const copied = await ctx.host.send({ op: "clipboard" });
        if (!copied.ok) throw new Error(String(copied.error ?? "clipboard-read-failed"));
        const text = String(copied.text ?? "");
        if (text !== sentinel && looksLikePoeItemText(text)) return text;
      }
      return "";
    } finally {
      await ctx.host.send({ op: "setclipboard", text: originalText });
    }
  }

  private async scan(
    ctx: SortRunContext,
    initial: SortCapture,
    safety: SortTabSafety,
  ): Promise<SortScan> {
    if (
      !initial.facts.stashPanelOpen ||
      !initial.facts.inventoryPanelOpen ||
      initial.facts.confidence < 0.9 ||
      !initial.facts.stashGridSize
    ) {
      throw new Error("stable-open-stash-and-bag-required");
    }
    const tab = tabDescriptor(ctx.profile, ctx.targetHwnd, safety, initial.tabVisualHash);
    const grid = activeStashGrid(ctx.profile);
    if (!grid || grid.cols !== tab.cols || grid.rows !== tab.rows) {
      throw new Error("active-grid-calibration-mismatch");
    }
    const sortedCells = [...initial.facts.occupiedStash].sort(
      (a, b) => a.row - b.row || a.col - b.col,
    );
    if (sortedCells.length > MAX_SCAN_CELLS) throw new Error("stash-grid-too-large-to-scan");
    const occupiedKeys = new Set(sortedCells.map(cellKey));
    const claimed = new Set<string>();
    const items: SortableStashItem[] = [];
    const issues: SortScanIssue[] = [];
    const db = (this.options.sizeDatabase ?? loadItemSizeDatabase)();
    const scale = tab.kind === "quad" ? 2 : 1;

    for (const cell of sortedCells) {
      if (claimed.has(cellKey(cell))) continue;
      if (ctx.abort.signal.aborted) throw new Error("cancelled");
      const text = await this.copyHoveredItem(ctx, initial, cell.x, cell.y);
      if (!looksLikePoeItemText(text)) {
        issues.push({
          code: "clipboard-copy-failed",
          message: `No item metadata was copied from occupied cell ${cell.row},${cell.col}.`,
          cells: [{ row: cell.row, col: cell.col }],
          blocking: true,
        });
        continue;
      }
      const parsed = parseItemText(text);
      const footprint = trustedSortFootprint(db, parsed);
      if (!footprint) {
        issues.push({
          code: "unknown-footprint",
          message:
            `${parsed.baseType} has no exact measured footprint (or fixed-class footprint); ` +
            "teach its size before sorting.",
          cells: [{ row: cell.row, col: cell.col }],
          blocking: true,
        });
        continue;
      }
      const stashFootprint = { w: footprint.w * scale, h: footprint.h * scale };
      const source = locateSortFootprint(
        cell,
        stashFootprint,
        occupiedKeys,
        claimed,
        tab.cols,
        tab.rows,
      );
      if (!source) {
        issues.push({
          code: "ambiguous-footprint-origin",
          message:
            `${parsed.baseType} could not be mapped to one unique, fully occupied ` +
            `${stashFootprint.w}×${stashFootprint.h} source rectangle.`,
          cells: [{ row: cell.row, col: cell.col }],
          blocking: true,
        });
        continue;
      }
      const item: SortableStashItem = {
        id: `${parsed.fingerprint}@${source.row},${source.col}`,
        fingerprint: parsed.fingerprint,
        itemClass: parsed.itemClass,
        baseType: parsed.baseType,
        source,
        w: stashFootprint.w,
        h: stashFootprint.h,
        bagW: footprint.w,
        bagH: footprint.h,
        footprintSource: footprint.source,
        confidence: initial.facts.confidence,
      };
      items.push(item);
      for (const covered of sortRectCells(source, item.w, item.h)) claimed.add(cellKey(covered));
      this.emit("identify", `${parsed.itemClass} / ${parsed.baseType}`, { itemCount: items.length });
    }

    await this.parkCursor(ctx, initial);
    const verified = await this.capture(ctx, "sort-scan-verified");
    if (
      cellSignature(verified.facts.occupiedStash) !== cellSignature(initial.facts.occupiedStash) ||
      cellSignature(verified.facts.occupiedBag) !== cellSignature(initial.facts.occupiedBag)
    ) {
      issues.push({
        code: "scan-state-changed",
        message: "Stash or bag occupancy changed during identification; preview is stale.",
        blocking: true,
      });
    }
    if (verified.tabVisualHash !== initial.tabVisualHash) {
      issues.push({
        code: "active-tab-changed",
        message: "The active stash-tab visual pin changed during identification.",
        blocking: true,
      });
    }
    return {
      capture: verified,
      tab,
      items,
      issues,
      occupiedStash: verified.facts.occupiedStash,
      bag: { cols: 12, rows: 5, occupied: verified.facts.occupiedBag },
    };
  }

  private itemCenter(
    capture: SortCapture,
    area: "stash" | "bag",
    origin: SortCell,
    w: number,
    h: number,
  ): { x: number; y: number } {
    const region = area === "stash" ? capture.facts.stashRegion : capture.facts.inventoryRegion;
    const grid =
      area === "stash"
        ? capture.facts.stashGridSize
        : { cols: 12, rows: 5 };
    if (!region || !grid) throw new Error(`${area}-grid-not-visible`);
    return {
      x: Math.round(region.x + ((origin.col + w / 2) * region.w) / grid.cols),
      y: Math.round(region.y + ((origin.row + h / 2) * region.h) / grid.rows),
    };
  }
}
