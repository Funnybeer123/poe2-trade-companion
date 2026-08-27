import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { bgrToGray, readBmpBgr } from "../adapters/bmp.js";
import { startWinHost } from "../adapters/winHost.js";
import { WinHostInputSink } from "../adapters/winHostInputSink.js";
import {
  assistiveMemoryStatus,
  clearScenarioMemory,
  learnFromDeposit,
  learnFromFill,
  loadAssistiveMemory,
  returnTargetsFromKnown,
  saveAssistiveMemory,
  scenarioExclusions,
  scenarioMemoryKey,
} from "../core/assistiveMemory.js";
import {
  appendBenchmark,
  loadBenchmarks,
  summarizeBenchmark,
  type AssistiveBenchmark,
  type AssistiveSkillId,
} from "../core/assistiveBenchmark.js";
import {
  claimItemFootprint,
  fitKnownSize,
  rememberItemCells,
  type StashItem,
} from "../core/bagPack.js";
import {
  activeStashGrid,
  profileReadyForDeposit,
  type CalibrationProfile,
} from "../core/calibrationProfile.js";
import { RuntimeCapabilities } from "../core/capabilities.js";
import {
  FILL_COPY,
  searchFillPool,
  sizeFillPool,
  wantedClassSizes,
} from "../core/fillIdentify.js";
import { GameInputController } from "../core/gameInputController.js";
import {
  cellLooksSearchLit,
  detectSpriteItems,
  searchMatchedCells,
} from "../core/itemSprites.js";
import {
  normalizeItemClass,
  searchQueryForClass,
  searchQueriesForClasses,
  searchScenarioQuery,
} from "../core/itemClassFilter.js";
import { loadItemSizeDatabase } from "../core/itemSizeStore.js";
import { KillSwitch } from "../core/killSwitch.js";
import { resolvePhysicalClient, type ScreenRect } from "../core/screenLayout.js";
import { scenario } from "../core/scenarios.js";
import {
  FillBagFromStash,
  DepositBagToStash,
  type Skill,
  type SkillStep,
} from "../core/skills.js";
import { isStashSearchClick, searchLooksFailed, stashSearchClick } from "../core/stashSearch.js";
import { runSkill, type SkillInput } from "../core/skillRunner.js";
import { validateTransferInput } from "../core/transferInputGuard.js";
import type {
  AutomationScenario,
  BotDecision,
  InputAction,
  QaActionTrace,
  RuntimeMode,
} from "../core/types.js";
import { perceiveUi, type UiFacts } from "../core/uiPerception.js";
import { isSafeStashSearchQuery } from "../core/voiceTransfer.js";

export type AssistiveRunKind = "fill" | "empty" | "two-cycle";

export interface AssistiveRunRequest {
  kind: AssistiveRunKind;
  dryRun: boolean;
  wantedClasses: string[];
  /** Audited, prevalidated stash query used by voice/literal one-shot fills. */
  searchQuery?: string;
  uniqueAcrossCycles: boolean;
  qaAcknowledged: boolean;
  allowlist: string[];
  actionsPerMinute?: number;
  maxItems?: number;
}

export interface AssistiveRunEvent {
  at: string;
  phase: string;
  message: string;
  cycle?: number;
  bagCells?: number;
  stashCells?: number;
  traceCount?: number;
  artifact?: string;
}

export interface AssistiveRunResult {
  ok: boolean;
  reason: string;
  kind: AssistiveRunKind;
  dryRun: boolean;
  cycles: number;
  elapsedMs: number;
  bagCells: number;
  stashCells: number;
  traces: QaActionTrace[];
  memory: ReturnType<typeof assistiveMemoryStatus>;
}

interface AssistiveRunServiceOptions {
  mode: RuntimeMode;
  qaOptIn: boolean;
  killSwitch: KillSwitch;
  memoryRoot: string;
  artifactDir: string;
  profile: () => CalibrationProfile;
  onEvent?: (event: AssistiveRunEvent) => void;
  hostFactory?: typeof startWinHost;
}

interface Capture {
  facts: UiFacts;
  client: ScreenRect;
  frame: ReturnType<typeof bgrToGray>;
  evidenceHash: string;
  bmpPath: string;
  previewPath: string;
}

interface RunContext {
  host: ReturnType<typeof startWinHost>;
  controller: GameInputController;
  scenario: AutomationScenario;
  processName: string;
  targetHwnd: string;
  processAllowed: boolean;
  profile: CalibrationProfile;
  abort: AbortController;
  lastCapture?: Capture;
  perceptionCursorParked?: boolean;
}

interface BenchmarkInput {
  skill: AssistiveSkillId;
  startedAtMs: number;
  identifyMs: number;
  before: UiFacts;
  after: UiFacts;
  verifiedBagAfter?: number;
  traceStart: number;
  result: string;
  cycle: number;
}

function now(): string {
  return new Date().toISOString();
}

function safeClasses(values: string[]): string[] {
  return [...new Set(values.map(normalizeItemClass).filter(Boolean))];
}

function verifiedNewBagCells(items: StashItem[]): number {
  return items.reduce((cells, item) => {
    const itemClass = normalizeItemClass(item.itemClass ?? "");
    if (!itemClass || itemClass === "Currency" || itemClass === "Stackable Currency") {
      return cells;
    }
    return cells + item.w * item.h;
  }, 0);
}

const DEFAULT_ONE_CELL_FINISHERS = ["Rings", "Amulets", "Jewels", "Charms"] as const;

function validateRunRequest(request: AssistiveRunRequest): void {
  if (!["fill", "empty", "two-cycle"].includes(request.kind)) {
    throw new Error("invalid-assistive-kind");
  }
  if (typeof request.dryRun !== "boolean" || !Array.isArray(request.wantedClasses)) {
    throw new Error("invalid-assistive-request");
  }
  if (
    !Array.isArray(request.allowlist) ||
    (!request.dryRun && !request.allowlist.some((entry) => String(entry).trim().length > 0))
  ) {
    throw new Error("process-allowlist-required");
  }
  if (
    request.actionsPerMinute != null &&
    (!Number.isFinite(request.actionsPerMinute) ||
      request.actionsPerMinute < 1 ||
      request.actionsPerMinute > 1_200)
  ) {
    throw new Error("invalid-actions-per-minute");
  }
  if (
    request.maxItems != null &&
    (!Number.isInteger(request.maxItems) || request.maxItems < 1 || request.maxItems > 60)
  ) {
    throw new Error("invalid-max-items");
  }
  if (
    request.searchQuery != null &&
    (typeof request.searchQuery !== "string" ||
      !isSafeStashSearchQuery(request.searchQuery))
  ) {
    throw new Error("invalid-stash-search-query");
  }
}

function occupiedSignature(cells: UiFacts["occupiedBag"]): string {
  return cells
    .map((cell) => `${cell.row},${cell.col}`)
    .sort()
    .join("|");
}

function transferPreflightStable(skill: Skill, before: UiFacts, after: UiFacts): boolean {
  if (
    !before.stashPanelOpen ||
    !before.inventoryPanelOpen ||
    !after.stashPanelOpen ||
    !after.inventoryPanelOpen ||
    before.confidence < 0.4 ||
    after.confidence < 0.4
  ) {
    return false;
  }
  if (occupiedSignature(before.occupiedBag) !== occupiedSignature(after.occupiedBag)) return false;
  if (
    skill.id === "fill-bag-from-stash" &&
    occupiedSignature(before.occupiedStash) !== occupiedSignature(after.occupiedStash)
  ) {
    return false;
  }
  return true;
}

export class AssistiveRunService {
  private running = false;
  private currentAbort?: AbortController;
  private last?: AssistiveRunResult;

  constructor(private readonly options: AssistiveRunServiceOptions) {
    mkdirSync(options.artifactDir, { recursive: true });
  }

  get status() {
    const profile = this.options.profile();
    return {
      running: this.running,
      killLatched: this.options.killSwitch.isLatched(),
      mode: this.options.mode,
      qaOptIn: this.options.qaOptIn,
      stashTab: profile.activeStashTab === "quad" ? "quad" as const : "normal" as const,
      gridsCalibrated: profileReadyForDeposit(profile),
      searchCalibrated: Boolean(profile.stashSearch),
      last: this.last,
    };
  }

  stop(reason = "operator-stop"): void {
    this.currentAbort?.abort(reason);
    this.options.killSwitch.trip();
    this.emit("stopped", reason);
  }

  memoryStatus(stashTab: "normal" | "quad", query: string) {
    const memory = loadAssistiveMemory(this.options.memoryRoot);
    return assistiveMemoryStatus(memory, scenarioMemoryKey(stashTab, query));
  }

  resetMemory(stashTab: "normal" | "quad", query: string) {
    const key = scenarioMemoryKey(stashTab, query);
    const next = clearScenarioMemory(loadAssistiveMemory(this.options.memoryRoot), key);
    saveAssistiveMemory(this.options.memoryRoot, next);
    return assistiveMemoryStatus(next, key);
  }

  async start(request: AssistiveRunRequest): Promise<AssistiveRunResult> {
    validateRunRequest(request);
    if (this.running) throw new Error("assistive-run-already-running");
    if (this.options.killSwitch.isLatched()) throw new Error("kill-switch-latched");

    const abort = new AbortController();
    this.currentAbort = abort;
    this.running = true;
    try {
      const result = await this.run({ ...request, wantedClasses: safeClasses(request.wantedClasses) }, abort);
      this.last = result;
      return result;
    } finally {
      this.running = false;
      this.currentAbort = undefined;
    }
  }

  private emit(phase: string, message: string, extra: Partial<AssistiveRunEvent> = {}): void {
    this.options.onEvent?.({ at: now(), phase, message, ...extra });
  }

  private appendTrace(entries: unknown[]): void {
    if (!entries.length) return;
    const file = path.join(this.options.artifactDir, "qa-action-trace.jsonl");
    appendFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  }

  private async run(request: AssistiveRunRequest, abort: AbortController): Promise<AssistiveRunResult> {
    const runStartedAt = Date.now();
    const profile = this.options.profile();
    if (!profileReadyForDeposit(profile)) throw new Error("stash-and-bag-calibration-required");
    if (
      !profile.stashSearch &&
      request.kind !== "empty" &&
      (request.wantedClasses.length > 0 || Boolean(request.searchQuery))
    ) {
      throw new Error("stash-search-not-calibrated");
    }

    const host = (this.options.hostFactory ?? startWinHost)();
    let cleanupSearch: (() => Promise<void>) | undefined;
    try {
      const target = await host.send({ op: "rect" });
      if (!target.ok) throw new Error(String(target.error ?? "target-window-missing"));
      if (!request.dryRun && !String(target.hwnd ?? "").trim()) {
        throw new Error("target-window-unpinned");
      }
      const targetProcess = String(target.process ?? "PathOfExile");
      const processName = /\.exe$/i.test(targetProcess) ? targetProcess : `${targetProcess}.exe`;
      const caps = new RuntimeCapabilities({
        mode: this.options.mode,
        buildAllowsQa: true,
        qaAcknowledged: true,
        assistiveAcknowledged: false,
        allowlist: request.allowlist,
        bannerVisible: true,
        emergencyStopRegistered: true,
      });
      const processAllowed = caps.isProcessAllowed(processName);
      if (!request.dryRun && !processAllowed) throw new Error("process-not-allowlisted");

      let ctx: RunContext | undefined;
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
      const controller = new GameInputController(sink, this.options.killSwitch, this.options.mode);
      const runScenario = scenario({
        id: `assistive-${request.kind}`,
        name: `Assistive ${request.kind}`,
        enabledModules: ["stash"],
        dryRun: request.dryRun,
        actionsPerMinute: request.actionsPerMinute ?? 240,
        confidenceThreshold: 0.4,
        timingProfile: "tight",
      });
      ctx = {
        host,
        controller,
        scenario: runScenario,
        processName,
        targetHwnd: String(target.hwnd ?? ""),
        processAllowed,
        profile,
        abort,
      };

      const focused = await this.execute(ctx, {
        module: "stash",
        rule: "focus-before-transfer",
        reason: "focus the allowlisted test target once before live input",
        confidence: 1,
        intended: [{ kind: "focus" }],
      });
      if (!request.dryRun && !focused.every((trace) => trace.result === "emitted")) {
        throw new Error("target-focus-failed");
      }

      let capture = await this.capture(ctx, profile, "initial");
      if (!request.dryRun) {
        await this.parkForPerception(ctx, profile);
        capture = await this.capture(ctx, profile, "initial-parked");
      }
      let verifiedBagCells = capture.facts.occupiedBag.length;
      let searchMayBeActive = false;
      cleanupSearch = async () => {
        if (
          request.dryRun ||
          !searchMayBeActive ||
          !profile.stashSearch ||
          abort.signal.aborted ||
          this.options.killSwitch.isLatched()
        ) {
          return;
        }
        try {
          await this.clearSearch(ctx, profile, capture);
          searchMayBeActive = false;
        } catch {
          // Preserve the original failure. The next fill clears/replaces search before transfer.
        }
      };
      const query = request.searchQuery ?? searchScenarioQuery(request.wantedClasses);
      const memoryKey = scenarioMemoryKey(
        profile.activeStashTab === "quad" ? "quad" : "normal",
        query,
      );
      let memory = loadAssistiveMemory(this.options.memoryRoot);
      let exclude = scenarioExclusions(memory, memoryKey, request.uniqueAcrossCycles);
      const withdrawn: StashItem[] = [];
      const results: Array<{ reason: string; result: "done" | "abort" }> = [];
      let itemLimitRemaining =
        Number.isFinite(request.maxItems) && Number(request.maxItems) > 0
          ? Math.floor(Number(request.maxItems))
          : Number.POSITIVE_INFINITY;

      if (request.dryRun) {
        if (request.kind !== "empty" && (request.searchQuery || request.wantedClasses.length)) {
          const previewQueries = request.searchQuery
            ? [request.searchQuery]
            : searchQueriesForClasses(request.wantedClasses);
          for (const classQuery of previewQueries) {
            await this.planSearch(ctx, profile, capture, classQuery);
          }
        }
        const skill =
          request.kind === "empty"
            ? new DepositBagToStash()
            : new FillBagFromStash(
                request.searchQuery && request.wantedClasses.length === 0
                  ? []
                  : Number.isFinite(itemLimitRemaining)
                    ? capture.facts.stashItems.slice(0, itemLimitRemaining)
                    : undefined,
                exclude,
                true,
                withdrawn,
                request.wantedClasses,
              );
        const preview = await this.previewSkill(ctx, skill, capture.facts);
        results.push(preview);
      } else {
        if (
          request.kind !== "empty" &&
          request.wantedClasses.length === 0 &&
          !request.searchQuery &&
          profile.stashSearch
        ) {
          await this.clearSearch(ctx, profile, capture);
          await new Promise<void>((resolve) => setTimeout(resolve, 180));
          capture = await this.capture(ctx, profile, "unfiltered-search-cleared");
        }
        const cycles = request.kind === "two-cycle" ? 2 : 1;
        let abortCycles = false;
        for (let cycle = 1; cycle <= cycles; cycle += 1) {
          if (abort.signal.aborted) throw new Error("cancelled");
          this.emit("cycle", `cycle ${cycle}/${cycles}`, {
            cycle,
            bagCells: capture.facts.occupiedBag.length,
            stashCells: capture.facts.occupiedStash.length,
          });

          if ((request.kind === "empty" || request.kind === "two-cycle") && capture.facts.occupiedBag.length > 0) {
            const before = capture.facts;
            const benchmarkStartedAt = Date.now();
            const traceStart = ctx.controller.actionTraces.length;
            const targets = returnTargetsFromKnown(before, withdrawn, memory, exclude, memoryKey);
            const deposit = new DepositBagToStash(targets);
            const result = await this.runLiveSkill(ctx, deposit, profile, capture);
            results.push(result.result);
            capture = result.capture;
            verifiedBagCells = capture.facts.occupiedBag.length;
            this.recordBenchmark(ctx, {
              skill: "deposit-bag-to-stash",
              startedAtMs: benchmarkStartedAt,
              identifyMs: 0,
              before,
              after: capture.facts,
              traceStart,
              result: result.result.reason,
              cycle,
            });
            memory = learnFromDeposit(
              memory,
              before,
              capture.facts,
              targets,
              deposit.returnedTo,
              memoryKey,
              request.uniqueAcrossCycles,
            );
            saveAssistiveMemory(this.options.memoryRoot, memory);
            if (result.result.result === "abort" || result.result.reason === "failed") {
              abortCycles = true;
              break;
            }
            if (capture.facts.occupiedBag.length > 0) break;
            withdrawn.length = 0;
            exclude = scenarioExclusions(memory, memoryKey, request.uniqueAcrossCycles);
          }

          if (request.kind === "fill" || request.kind === "two-cycle") {
            const fillRequests = request.searchQuery
              ? [{ wantedClasses: request.wantedClasses, query: request.searchQuery }]
              : request.wantedClasses.length
                ? request.wantedClasses.map((itemClass) => ({
                    wantedClasses: [itemClass],
                    query: searchQueryForClass(itemClass),
                  }))
                : [
                    { wantedClasses: [] as string[], query: "" },
                    ...DEFAULT_ONE_CELL_FINISHERS.map((itemClass) => ({
                      wantedClasses: [itemClass],
                      query: searchQueryForClass(itemClass),
                    })),
                  ];
            let stopAllFills = false;
            for (const fillRequest of fillRequests) {
              const attemptedForClass = new Set<string>();
              const maxBatches = fillRequest.query ? 16 : 1;
              let exhausted = false;
              for (let batchIndex = 0; batchIndex < maxBatches; batchIndex += 1) {
                if (verifiedBagCells >= 60 || itemLimitRemaining <= 0) {
                  results.push({
                    result: "done",
                    reason: itemLimitRemaining <= 0 ? "max-items-reached" : "bag-full",
                  });
                  stopAllFills = true;
                  break;
                }
                const benchmarkBefore = capture.facts;
                const benchmarkStartedAt = Date.now();
                const traceStart = ctx.controller.actionTraces.length;
                const effectiveExclude = fillRequest.query
                  ? new Set([...exclude, ...attemptedForClass])
                  : exclude;
                if (fillRequest.query) searchMayBeActive = true;
                const prepared = fillRequest.query
                  ? await this.applyClassSearch(
                      ctx,
                      profile,
                      capture,
                      fillRequest.wantedClasses,
                      fillRequest.query,
                      effectiveExclude,
                      Number.isFinite(itemLimitRemaining) ? itemLimitRemaining : undefined,
                    )
                  : undefined;
                if (prepared?.capture) capture = prepared.capture;
                for (const skipped of prepared?.skipped ?? []) {
                  rememberItemCells(attemptedForClass, skipped);
                }
                const identifyMs = Date.now() - benchmarkStartedAt;

                if (prepared && prepared.items.length === 0) {
                  await this.clearSearch(ctx, profile, capture);
                  searchMayBeActive = false;
                  await new Promise<void>((resolve) => setTimeout(resolve, 180));
                  capture = await this.capture(ctx, profile, "class-search-cleared");
                  this.recordBenchmark(ctx, {
                    skill: "fill-bag-from-stash",
                    startedAtMs: benchmarkStartedAt,
                    identifyMs,
                    before: benchmarkBefore,
                    after: capture.facts,
                    verifiedBagAfter: verifiedBagCells,
                    traceStart,
                    result: prepared.attempts === 0 ? "filter-exhausted" : "no-matching-items",
                    cycle,
                  });
                  if (prepared.attempts === 0) {
                    exhausted = true;
                    results.push({ result: "done", reason: "filter-exhausted" });
                    break;
                  }
                  continue;
                }

                const withdrawnBefore = withdrawn.length;
                const availableItems = prepared?.items ?? capture.facts.stashItems;
                const fill = new FillBagFromStash(
                  Number.isFinite(itemLimitRemaining)
                    ? availableItems.slice(0, itemLimitRemaining)
                    : availableItems,
                  effectiveExclude,
                  true,
                  withdrawn,
                  fillRequest.wantedClasses,
                );
                const result = await this.runLiveSkill(ctx, fill, profile, capture);
                capture = result.capture;
                const movedItems = withdrawn.slice(withdrawnBefore);
                verifiedBagCells = Math.max(
                  capture.facts.occupiedBag.length,
                  Math.min(60, verifiedBagCells + verifiedNewBagCells(movedItems)),
                );
                const rejectedOneCellProbe =
                  capture.facts.occupiedBag.length >= 59 &&
                  prepared?.items.some((item) => {
                    const itemClass = normalizeItemClass(item.itemClass ?? "");
                    return (
                      item.w === 1 &&
                      item.h === 1 &&
                      itemClass !== "Currency" &&
                      itemClass !== "Stackable Currency"
                    );
                  }) === true &&
                  (result.result.reason === "failed" ||
                    result.result.reason === "no-more-auto-fit");
                if (rejectedOneCellProbe) verifiedBagCells = 60;
                const effectiveResult = rejectedOneCellProbe
                  ? ({ result: "done", reason: "bag-full" } as const)
                  : result.result;
                results.push(effectiveResult);
                if (verifiedBagCells >= 60) {
                  results.push({ result: "done", reason: "bag-full" });
                }
                for (const item of movedItems) rememberItemCells(exclude, item);
                if (Number.isFinite(itemLimitRemaining)) {
                  itemLimitRemaining = Math.max(0, itemLimitRemaining - movedItems.length);
                }
                memory = learnFromFill(memory, withdrawn, memoryKey, request.uniqueAcrossCycles);
                saveAssistiveMemory(this.options.memoryRoot, memory);
                const stopFill =
                  effectiveResult.result === "abort" ||
                  effectiveResult.reason === "failed" ||
                  verifiedBagCells >= 60 ||
                  itemLimitRemaining <= 0;
                if (effectiveResult.result === "abort" || effectiveResult.reason === "failed") {
                  abortCycles = true;
                }
                if (
                  prepared &&
                  result.result.reason === "no-more-auto-fit" &&
                  withdrawn.length === withdrawnBefore
                ) {
                  for (const item of prepared.items) rememberItemCells(attemptedForClass, item);
                }
                if (fillRequest.query) {
                  await this.clearSearch(ctx, profile, capture);
                  searchMayBeActive = false;
                  await new Promise<void>((resolve) => setTimeout(resolve, 180));
                  capture = await this.capture(ctx, profile, "class-search-cleared");
                }
                this.recordBenchmark(ctx, {
                  skill: "fill-bag-from-stash",
                  startedAtMs: benchmarkStartedAt,
                  identifyMs,
                  before: benchmarkBefore,
                  after: capture.facts,
                  verifiedBagAfter: verifiedBagCells,
                  traceStart,
                  result: verifiedBagCells >= 60 ? "bag-full" : effectiveResult.reason,
                  cycle,
                });
                if (stopFill) {
                  stopAllFills = true;
                  break;
                }
                if (
                  fillRequest.query &&
                  result.result.reason === "no-more-auto-fit"
                ) {
                  exhausted = true;
                  break;
                }
                if (!fillRequest.query) break;
              }
              if (
                fillRequest.query &&
                !exhausted &&
                !stopAllFills &&
                verifiedBagCells < 60
              ) {
                results.push({ result: "abort", reason: "failed" });
                stopAllFills = true;
                abortCycles = true;
              }
              if (stopAllFills) break;
            }
          }

          if (abortCycles) break;
          if (request.kind === "two-cycle" && capture.facts.occupiedBag.length > 0) {
            const before = capture.facts;
            const benchmarkStartedAt = Date.now();
            const traceStart = ctx.controller.actionTraces.length;
            const targets = returnTargetsFromKnown(before, withdrawn, memory, exclude, memoryKey);
            const deposit = new DepositBagToStash(targets);
            const result = await this.runLiveSkill(ctx, deposit, profile, capture);
            results.push(result.result);
            capture = result.capture;
            verifiedBagCells = capture.facts.occupiedBag.length;
            this.recordBenchmark(ctx, {
              skill: "deposit-bag-to-stash",
              startedAtMs: benchmarkStartedAt,
              identifyMs: 0,
              before,
              after: capture.facts,
              traceStart,
              result: result.result.reason,
              cycle,
            });
            memory = learnFromDeposit(
              memory,
              before,
              capture.facts,
              targets,
              deposit.returnedTo,
              memoryKey,
              request.uniqueAcrossCycles,
            );
            saveAssistiveMemory(this.options.memoryRoot, memory);
            withdrawn.length = 0;
            exclude = scenarioExclusions(memory, memoryKey, request.uniqueAcrossCycles);
            if (result.result.result === "abort" || result.result.reason === "failed") break;
          }
        }
      }

      const finalCapture = await this.capture(ctx, profile, "final");
      const failed = results.find((result) => result.result === "abort" || result.reason === "failed");
      const reachedItemLimit =
        Number.isFinite(request.maxItems) &&
        Number(request.maxItems) > 0 &&
        itemLimitRemaining <= 0;
      const result: AssistiveRunResult = {
        ok: !failed,
        reason:
          failed?.reason ??
          (request.dryRun
            ? "dry-run-preview"
            : reachedItemLimit
              ? "max-items-reached"
              : results.at(-1)?.reason ?? "source-empty"),
        kind: request.kind,
        dryRun: request.dryRun,
        cycles: request.kind === "two-cycle" ? 2 : 1,
        elapsedMs: Date.now() - runStartedAt,
        bagCells: Math.max(finalCapture.facts.occupiedBag.length, verifiedBagCells),
        stashCells: finalCapture.facts.occupiedStash.length,
        traces: controller.actionTraces,
        memory: assistiveMemoryStatus(memory, memoryKey),
      };
      this.emit("complete", result.reason, {
        bagCells: result.bagCells,
        stashCells: result.stashCells,
        traceCount: result.traces.length,
      });
      return result;
    } finally {
      try {
        await cleanupSearch?.();
      } finally {
        await host.close();
      }
    }
  }

  private recordBenchmark(ctx: RunContext, input: BenchmarkInput): void {
    const elapsedMs = Date.now() - input.startedAtMs;
    const bagAfter = Math.max(
      input.after.occupiedBag.length,
      input.verifiedBagAfter ?? input.after.occupiedBag.length,
    );
    const complete =
      input.skill === "deposit-bag-to-stash"
        ? bagAfter === 0
        : bagAfter >= 60;
    const run: AssistiveBenchmark = {
      id: `${input.skill}-${input.startedAtMs}-${input.cycle}`,
      skill: input.skill,
      startedAt: new Date(input.startedAtMs).toISOString(),
      elapsedMs,
      identifyMs: Math.min(elapsedMs, Math.max(0, input.identifyMs)),
      actMs: Math.max(0, elapsedMs - input.identifyMs),
      bagBefore: input.before.occupiedBag.length,
      bagAfter,
      stashBefore: input.before.occupiedStash.length,
      stashAfter: input.after.occupiedStash.length,
      actions: ctx.controller.actionTraces
        .slice(input.traceStart)
        .filter((trace) => trace.result === "emitted").length,
      result: input.result,
      complete,
      cycle: input.cycle,
    };
    const previous = loadBenchmarks(this.options.memoryRoot)
      .filter((entry) => entry.skill === input.skill)
      .at(-1);
    appendBenchmark(this.options.memoryRoot, run);
    this.emit("benchmark", summarizeBenchmark(run, previous), {
      cycle: input.cycle,
      bagCells: run.bagAfter,
      stashCells: run.stashAfter,
    });
  }

  private async capture(
    ctx: RunContext,
    profile: CalibrationProfile,
    phase: string,
  ): Promise<Capture> {
    if (ctx.abort.signal.aborted) throw new Error("cancelled");
    const rect = await ctx.host.send({ op: "rect", expectedHwnd: ctx.targetHwnd });
    if (!rect.ok) throw new Error(String(rect.error ?? "target-window-missing"));
    const captureId = `assistive-${Date.now()}`;
    const file = path.join(this.options.artifactDir, `${captureId}.bmp`);
    const previewPath = path.join(this.options.artifactDir, `${captureId}.png`);
    const captured = await ctx.host.send({
      op: "capture",
      path: file,
      previewPath,
      expectedHwnd: ctx.targetHwnd,
      requireForeground: !ctx.scenario.dryRun,
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
      { left: Number(rect.monitorLeft ?? captured.left ?? 0), top: Number(rect.monitorTop ?? captured.top ?? 0) },
    );
    const bgr = readBmpBgr(file);
    const frame = bgrToGray(bgr);
    const facts = perceiveUi(frame, client, {}, profile, bgr);
    const evidenceHash = createHash("sha256")
      .update(JSON.stringify({
        bag: facts.occupiedBag.map((cell) => [cell.row, cell.col]),
        stash: facts.occupiedStash.map((cell) => [cell.row, cell.col]),
        reason: facts.reason,
      }))
      .digest("hex");
    const next = { facts, client, frame, evidenceHash, bmpPath: file, previewPath };
    ctx.lastCapture = next;
    const perceptionTrace = {
      timestamp: now(),
      type: "perception",
      phase,
      evidenceHash,
      reason: facts.reason,
      confidence: facts.confidence,
      bagCells: facts.occupiedBag.length,
      stashCells: facts.occupiedStash.length,
    };
    this.appendTrace([perceptionTrace]);
    this.emit("capture", phase, {
      bagCells: facts.occupiedBag.length,
      stashCells: facts.occupiedStash.length,
      artifact: previewPath,
    });
    return next;
  }

  private async execute(ctx: RunContext, decision: BotDecision, batch?: { ctrl?: boolean; shift?: boolean }) {
    if (ctx.abort.signal.aborted) throw new Error("cancelled");
    if (
      decision.rule !== "perception-cursor-park" &&
      decision.intended.some((action) =>
        action.kind === "click" || action.kind === "move" || action.kind === "drag"
      )
    ) {
      ctx.perceptionCursorParked = false;
    }
    const capture = ctx.lastCapture;
    const traces = batch
      ? await ctx.controller.executeBatch(
          decision,
          ctx.scenario,
          ctx.processName,
          capture?.evidenceHash ?? "pre-capture",
          ctx.processAllowed,
          batch,
        )
      : await ctx.controller.execute(
          decision,
          ctx.scenario,
          ctx.processName,
          capture?.evidenceHash ?? "pre-capture",
          ctx.processAllowed,
        );
    this.appendTrace(traces);
    this.emit("input", decision.reason, { traceCount: ctx.controller.actionTraces.length });
    if (!ctx.scenario.dryRun) {
      const rejected = traces.find((trace) => trace.result === "failed" || trace.result === "blocked");
      if (rejected) throw new Error(`input-${rejected.result}: ${rejected.reason}`);
    }
    return traces;
  }

  private skillInput(ctx: RunContext): SkillInput {
    const send = async (
      actions: InputAction[],
      reason: string,
      batch?: { ctrl?: boolean; shift?: boolean },
    ): Promise<{ ok: boolean; error?: string }> => {
      const traces = await this.execute(
        ctx,
        {
          module: "stash",
          rule: "closed-loop-transfer",
          reason,
          intended: actions,
          confidence: ctx.lastCapture?.facts.confidence ?? 0,
        },
        batch,
      );
      const failed = traces.find((trace) => trace.result !== "emitted");
      return failed ? { ok: false, error: failed.reason } : { ok: true };
    };
    return {
      click: (x, y, ctrl, shift) =>
        send([{ kind: "click", x, y }], "skill-click", ctrl ? { ctrl: true, shift } : undefined),
      hotkey: async (keys) => {
        const result = await send([{ kind: "key", key: keys }], "skill-hotkey");
        return { ok: result.ok };
      },
      move: (x, y) => send([{ kind: "move", x, y }], "skill-move"),
      drag: (fromX, fromY, toX, toY) =>
        send([{ kind: "drag", x: fromX, y: fromY, x2: toX, y2: toY }], "skill-drag"),
      burstCtrlClick: (points, options) =>
        send(
          points.map((point) => ({ kind: "click", x: point.x, y: point.y })),
          "verified-ctrl-burst",
          { ctrl: true, shift: options?.shift },
        ),
      rightClick: (x, y) => send([{ kind: "click", x, y, button: "right" }], "clear-held-cursor"),
      wait: async (ms) => {
        await new Promise<void>((resolve) => setTimeout(resolve, ms));
      },
      cancelled: () => ctx.abort.signal.aborted || this.options.killSwitch.isLatched(),
    };
  }

  private async runLiveSkill(
    ctx: RunContext,
    skill: Skill,
    profile: CalibrationProfile,
    first: Capture,
  ) {
    await this.parkForPerception(ctx, profile);
    const verified = await this.capture(ctx, profile, `${skill.id}-preflight`);
    if (!transferPreflightStable(skill, first.facts, verified.facts)) {
      throw new Error("transfer-grid-unstable-before-input");
    }
    let initial: Capture | undefined = verified;
    const result = await runSkill(
      skill,
      {
        capture: async () => {
          if (initial) {
            const value = initial;
            initial = undefined;
            ctx.lastCapture = value;
            return value;
          }
          await this.parkForPerception(ctx, profile);
          return this.capture(ctx, profile, skill.id);
        },
      },
      this.skillInput(ctx),
      48,
    );
    await this.parkForPerception(ctx, profile);
    const capture = await this.capture(ctx, profile, `${skill.id}-result`);
    return { result, capture };
  }

  private async parkForPerception(
    ctx: RunContext,
    profile: CalibrationProfile,
  ): Promise<void> {
    const capture = ctx.lastCapture;
    if (
      !capture ||
      !profile.stashSearch ||
      ctx.perceptionCursorParked
    ) {
      return;
    }
    const point = this.searchPoint(profile, capture);
    await this.execute(ctx, {
      module: "stash",
      rule: "perception-cursor-park",
      reason: "park cursor outside item grids before capture",
      confidence: 1,
      intended: [{ kind: "move", ...point }],
    });
    ctx.perceptionCursorParked = true;
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }

  private async previewSkill(
    ctx: RunContext,
    skill: Skill,
    facts: UiFacts,
  ): Promise<{ result: "done" | "abort"; reason: string }> {
    for (let stepNo = 0; stepNo < 6; stepNo += 1) {
      const step: SkillStep = skill.plan(facts);
      if (step.kind === "done" || step.kind === "abort") {
        return { result: step.kind, reason: step.reason };
      }
      if (step.kind === "wait") continue;
      const actions = step.kind === "burst" ? step.actions : [step.action];
      await this.execute(
        ctx,
        {
          module: "stash",
          rule: "dry-run-preview",
          reason: step.reason,
          intended: actions,
          confidence: facts.confidence,
        },
        step.kind === "burst" ? { ctrl: true, shift: step.shift } : undefined,
      );
      if (step.kind === "burst") return { result: "done", reason: "dry-run-preview" };
    }
    return { result: "abort", reason: "dry-run-preview-incomplete" };
  }

  private searchPoint(profile: CalibrationProfile, capture: Capture): { x: number; y: number } {
    const box = profile.stashSearch;
    if (!box) throw new Error("stash-search-not-calibrated");
    if (!capture.facts.stashPanelOpen || !capture.facts.stashRegion) {
      throw new Error("stash-panel-required-for-search");
    }
    const screenBox = {
      x: capture.client.left + box.x,
      y: capture.client.top + box.y,
      w: box.w,
      h: box.h,
    };
    const point = stashSearchClick(screenBox);
    if (!isStashSearchClick(point, screenBox, capture.facts.stashRegion)) {
      throw new Error("stash-search-calibration-outside-stash-chrome");
    }
    return point;
  }

  private async planSearch(
    ctx: RunContext,
    profile: CalibrationProfile,
    capture: Capture,
    query: string,
  ): Promise<void> {
    const point = this.searchPoint(profile, capture);
    await this.execute(ctx, {
      module: "stash",
      rule: "calibrated-class-search",
      reason: `apply calibrated stash search ${query}`,
      confidence: capture.facts.confidence,
      intended: [
        { kind: "click", ...point },
        { kind: "key", key: "ctrl+a" },
        { kind: "type", text: query },
      ],
    });
  }

  private async copyHoveredItem(
    ctx: RunContext,
    capture: Capture,
    x: number,
    y: number,
  ): Promise<string> {
    const original = await ctx.host.send({ op: "clipboard" });
    if (!original.ok) throw new Error(String(original.error ?? "clipboard-read-failed"));
    const originalText = String(original.text ?? "");
    const sentinel = `poe2-assistive-copy-${Date.now()}`;
    try {
      await this.execute(ctx, {
        module: "stash",
        rule: "bounded-item-identification",
        reason: "hover a bounded clipboard-identification candidate",
        confidence: capture.facts.confidence,
        intended: [{ kind: "move", x, y }],
      });
      await new Promise<void>((resolve) => setTimeout(resolve, FILL_COPY.hoverMs));
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const cleared = await ctx.host.send({ op: "setclipboard", text: sentinel });
        if (!cleared.ok) throw new Error(String(cleared.error ?? "clipboard-write-failed"));
        await this.execute(ctx, {
          module: "stash",
          rule: "bounded-item-identification",
          reason: `copy hovered item metadata attempt ${attempt + 1}`,
          confidence: capture.facts.confidence,
          intended: [{ kind: "key", key: "ctrl+c" }],
        });
        await new Promise<void>((resolve) =>
          setTimeout(resolve, attempt === 0 ? FILL_COPY.copyMs + 20 : FILL_COPY.afterMs + 30),
        );
        const copied = await ctx.host.send({ op: "clipboard" });
        if (!copied.ok) throw new Error(String(copied.error ?? "clipboard-read-failed"));
        const text = String(copied.text ?? "");
        if (text !== sentinel && /Item Class:/i.test(text)) return text;
      }
      return "";
    } finally {
      await ctx.host.send({ op: "setclipboard", text: originalText });
    }
  }

  private async identifyFillItems(
    ctx: RunContext,
    profile: CalibrationProfile,
    capture: Capture,
    sprites: StashItem[],
    occupiedStash: UiFacts["occupiedStash"],
    wantedClasses: string[],
    exclude: Set<string>,
    phase: string,
    maxMatches?: number,
  ): Promise<{ items: StashItem[]; skipped: StashItem[]; attempts: number; capture: Capture }> {
    const bagRegion = capture.facts.inventoryRegion;
    const grid = activeStashGrid(profile);
    if (!bagRegion || !grid) throw new Error("stash-and-bag-not-visible");
    const result = await sizeFillPool({
      sprites,
      occupiedStash,
      occupiedBag: capture.facts.occupiedBag,
      bagRegion,
      stashCols: grid.cols,
      exclude,
      sizeDb: loadItemSizeDatabase(),
      wantedClasses,
      maxMatches,
      copyItem: (x, y) => this.copyHoveredItem(ctx, capture, x, y),
    });
    await this.parkForPerception(ctx, profile);
    this.emit("identify", `verified ${result.items.length}/${result.copies} copied candidates`, {
      bagCells: capture.facts.occupiedBag.length,
      stashCells: capture.facts.occupiedStash.length,
    });
    await new Promise<void>((resolve) => setTimeout(resolve, FILL_COPY.afterMs));
    return {
      items: result.items,
      skipped: result.skipped,
      attempts: result.copies,
      capture: await this.capture(ctx, profile, phase),
    };
  }

  private async applyClassSearch(
    ctx: RunContext,
    profile: CalibrationProfile,
    capture: Capture,
    wantedClasses: string[],
    query: string,
    exclude: Set<string>,
    maxMatches?: number,
  ): Promise<{ items: StashItem[]; skipped: StashItem[]; attempts: number; capture: Capture }> {
    if (!query) throw new Error("class-search-unavailable");
    const beforeOccupied = capture.facts.occupiedStash.filter(
      (cell) => !exclude.has(`${cell.row},${cell.col}`),
    ).length;
    await this.planSearch(ctx, profile, capture, query);
    await new Promise<void>((resolve) => setTimeout(resolve, 240));
    const after = await this.capture(ctx, profile, "class-search");
    const stash = after.facts.stashRegion;
    const bag = after.facts.inventoryRegion;
    const grid = activeStashGrid(profile);
    if (!stash || !grid) throw new Error("stash-grid-not-visible");
    if (!bag) throw new Error("bag-grid-not-visible");
    const classSizes = wantedClassSizes(wantedClasses);
    if (classSizes.length === 1) {
      const matched = searchMatchedCells(
        capture.frame,
        after.frame,
        after.client,
        stash,
        grid.cols,
        grid.rows,
      );
      if (matched.length > 0) {
        const size = classSizes[0]!;
        const occupiedKeys = new Set(
          capture.facts.occupiedStash.map((cell) => `${cell.row},${cell.col}`),
        );
        const claimed = new Set<string>();
        const sprites: StashItem[] = [];
        for (const cell of matched) {
          const sized = {
            ...fitKnownSize(
              {
                id: `${cell.row},${cell.col}:1x1`,
                grab: {
                  row: cell.row,
                  col: cell.col,
                  x: cell.x,
                  y: cell.y,
                  bag: "stash",
                },
                cells: [{ row: cell.row, col: cell.col }],
                w: 1,
                h: 1,
              },
              size.w,
              size.h,
              occupiedKeys,
            ),
            itemClass: wantedClasses[0],
          };
          if (claimItemFootprint(claimed, sized)) sprites.push(sized);
        }
        const prepared = searchFillPool({
          sprites,
          occupiedStash: capture.facts.occupiedStash,
          occupiedBag: after.facts.occupiedBag,
          bagRegion: bag,
          stashCols: grid.cols,
          exclude,
          wantedClasses,
          query,
          litCells: matched.length,
        });
        const limit = Number.isFinite(maxMatches)
          ? Math.max(0, Math.floor(Number(maxMatches)))
          : prepared.items.length;
        await this.parkForPerception(ctx, profile);
        this.emit(
          "identify",
          `verified ${Math.min(limit, prepared.items.length)} differential search candidates`,
          {
            bagCells: after.facts.occupiedBag.length,
            stashCells: after.facts.occupiedStash.length,
          },
        );
        await new Promise<void>((resolve) => setTimeout(resolve, FILL_COPY.afterMs));
        return {
          items: prepared.items.slice(0, limit),
          skipped: prepared.skipped,
          attempts: matched.length,
          capture: await this.capture(ctx, profile, "class-search-differential-settled"),
        };
      }
    }
    const items = detectSpriteItems(
      after.frame,
      after.client,
      stash,
      grid.cols,
      grid.rows,
      cellLooksSearchLit,
    );
    const litOccupied = items.reduce((sum, item) => sum + item.cells.length, 0);
    if (searchLooksFailed(beforeOccupied, litOccupied)) {
      await this.clearSearch(ctx, profile, after);
      await new Promise<void>((resolve) => setTimeout(resolve, 180));
      const unfiltered = await this.capture(ctx, profile, "class-search-fallback");
      if (wantedClasses.length === 0) {
        return { items: [], skipped: [], attempts: 0, capture: unfiltered };
      }
      return this.identifyFillItems(
        ctx,
        profile,
        unfiltered,
        unfiltered.facts.stashItems,
        unfiltered.facts.occupiedStash,
        wantedClasses,
        exclude,
        "class-search-fallback-settled",
        maxMatches,
      );
    }
    if (items.length === 0) return { items: [], skipped: [], attempts: 0, capture: after };
    const litStash = items.flatMap((item) =>
      item.cells.map((cell) => ({ ...cell, x: item.grab.x, y: item.grab.y, bag: "stash" })),
    );
    return this.identifyFillItems(
      ctx,
      profile,
      after,
      items,
      litStash,
      wantedClasses,
      exclude,
      "class-search-identify-settled",
      maxMatches,
    );
  }

  private async clearSearch(
    ctx: RunContext,
    profile: CalibrationProfile,
    capture: Capture,
  ): Promise<void> {
    if (!profile.stashSearch) return;
    const point = this.searchPoint(profile, capture);
    await this.execute(ctx, {
      module: "stash",
      rule: "clear-calibrated-search",
      reason: "clear stash search after transfer",
      confidence: capture.facts.confidence,
      intended: [
        { kind: "click", ...point },
        { kind: "key", key: "ctrl+a" },
        { kind: "key", key: "backspace" },
      ],
    });
  }
}
