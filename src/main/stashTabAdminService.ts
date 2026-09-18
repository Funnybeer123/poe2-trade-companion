/**
 * Main-process service behind the Stash Tabs panel: surveys the tab strip,
 * builds the gear-slot plan, and executes renames/recolours through the
 * in-game Stash Tab Settings dialog.
 *
 * Protected tabs — priced (`~price ...`) and Remove-only — are refused by the
 * planner, again by the validator, and a third time by the executor's read-back
 * of the live dialog, so no single mis-read can rewrite a public listing.
 */
import path from "node:path";
import { existsSync } from "node:fs";
import { execFile, spawn } from "node:child_process";
import type { StashTabScriptKind } from "../shared/ipc.js";
export type { StashTabScriptKind } from "../shared/ipc.js";
import { DrainKit } from "../adapters/drainKit.js";
import { StashTabKit, type StripEntry } from "../adapters/stashTabKit.js";
import { startWinHost } from "../adapters/winHost.js";
import { labelsSimilar } from "../core/tabList.js";
import {
  buildGearTabPlan,
  isRemoveOnlyTabLabel,
  looksPricedTabLabel,
  validateStashTabPlan,
  type StashTabPlan,
  type StashTabAdminEvent,
  type StashTabAdminStatus,
  type StashTabApplyOutcome,
  type StashTabSurveyResult,
  type SurveyedStashTab,
} from '../core/stashTabAdmin.js';



export interface StashTabAdminOptions {
  root: string;
  /** Shares the app's existing market config without copying credentials into artifacts. */
  marketConfigDir?: string;
  /** Standalone bundled worker and writable settings/report root in packaged builds. */
  valuationWorker?: { executable: string; file: string; dataRoot: string };
  templateDir?: string;
  emit?: (event: StashTabAdminEvent) => void;
  /** Blocks every game-touching operation while it returns false. */
  canRun?: () => boolean;
  onScriptStopped?: (kind: StashTabScriptKind, reason: string) => void;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const SCRIPT_ARGS: Record<StashTabScriptKind, string[]> = {
  "sort-inventory": ["scripts/assistive-sort-tabs.ts", "--run"],
  "sort-inventory-dry": ["scripts/assistive-sort-tabs.ts"],
  "vendor-cycle": ["scripts/vendor-cycle.ts", "--run"],
  "vendor-cycle-dry": ["scripts/vendor-cycle.ts", "--dry-run"],
  renumber: ["scripts/stash-tab-admin.ts", "--renumber"],
  "renumber-dry": ["scripts/stash-tab-admin.ts", "--renumber", "--dry-run"],
  "finish-gear": ["scripts/stash-tab-admin.ts", "--finish-gear", "--allow-priced"],
  "sort-gear": ["scripts/sort-gear.ts"],
  "sort-gear-dry": ["scripts/sort-gear.ts", "--dry-run"],
  "value-dump": ["scripts/value-dump.ts"],
  "value-dump-sort": ["scripts/value-dump.ts", "--move"],
  "value-dump-resume": ["scripts/value-dump.ts", "--pending-only"],
  "value-dump-capture-resume": ["scripts/value-dump.ts", "--resume-capture"],
  "craft-gear": ["scripts/craft-gear.ts", "--live"],
  "craft-gear-dry": ["scripts/craft-gear.ts"],
  // Shop listings (docs/HANDOFF-shop-listings.md). Dry scans read the tab
  // and print the plan; --record appends the reconcile (sold detection);
  // --live executes the plan; the step variant teaches the price dialog.
  "shop-scan-dry": ["scripts/shop.ts"],
  "shop-scan": ["scripts/shop.ts", "--record"],
  "shop-apply": ["scripts/shop.ts", "--live"],
  "shop-apply-step": ["scripts/shop.ts", "--live", "--step"],
  "shop-list-dry": ["scripts/shop.ts", "--list"],
  "shop-list": ["scripts/shop.ts", "--live", "--list"],
  // Price-bucket tabs: the one-key flow (also Num4 in the action daemon).
  "shop-buckets-dry": ["scripts/shop-buckets.ts"],
  "shop-buckets": ["scripts/shop-buckets.ts", "--live"],
  // Merchant listings: keep Chaos/Divine only, delist every other currency.
  "shop-currency-sweep-dry": ["scripts/shop.ts", "--currency-sweep", "--current", "--max-actions=144"],
  "shop-currency-sweep": ["scripts/shop.ts", "--currency-sweep", "--current", "--live", "--max-actions=144"],
};

export class StashTabAdminService {
  private state: StashTabAdminStatus = { running: false, phase: "idle" };
  private readonly templateDir: string;
  private child: ReturnType<typeof spawn> | undefined;
  private childKind: StashTabScriptKind | undefined;
  private stoppingChild: ReturnType<typeof spawn> | undefined;
  private treeStopPending = false;

  /**
   * Run one of the packaged stash operations. They live as self-contained CLI
   * scripts (also reachable via `npm run tabs:renumber` etc.), so the panel
   * and the terminal share one battle-tested implementation.
   */
  runScript(kind: StashTabScriptKind): { started: boolean; reason?: string } {
    if (this.state.running || this.child) return { started: false, reason: "busy" };
    if (this.options.canRun && !this.options.canRun()) return { started: false, reason: "blocked" };
    const configured = SCRIPT_ARGS[kind];
    if (!configured) return { started: false, reason: `unknown-script:${kind}` };
    const args = [...configured];
    const valuation = kind.startsWith("value-dump");
    const bundled = this.options.valuationWorker;
    const worker = bundled ? { ...bundled, file: valuation ? bundled.file : path.join(path.dirname(bundled.file), path.basename(args[0], ".ts") + ".mjs") } : undefined;
    if (worker && !existsSync(worker.file)) return { started: false, reason: "Packaged worker missing. Rebuild the app." };
    if (kind === "value-dump-resume" || kind === "value-dump-sort" || kind === "value-dump-capture-resume") {
      const relativeReport = path.join("artifacts", "tab-admin", "stash-valuation-report.json");
      const savedReport = path.join(worker?.dataRoot ?? this.options.root, relativeReport);
      if (!existsSync(savedReport)) return { started: false, reason: "no-saved-report" };
      // Development uses a fixed relative argument so workspace names never
      // become shell syntax. Packaged workers receive an absolute path without a shell.
      args.push("--from-scan=" + (worker ? savedReport : relativeReport));
    }
    this.setPhase("applying");
    this.state = { ...this.state, lastError: undefined };
    const child = spawn(worker?.executable ?? "npx", worker ? [worker.file, ...args.slice(1)] : ["--yes", "tsx", ...args], {
      cwd: worker?.dataRoot ?? this.options.root,
      shell: !worker,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      // Live crafting is double-gated: the script demands this env var on top
      // of --live, so only the explicit craft-gear kind can ever arm it.
      env: {
        ...process.env,
        ...(kind === "craft-gear" ? { POE2_CRAFT_LIVE: "1" } : {}),
        ...(this.options.marketConfigDir
          ? { POE2_MARKET_CONFIG_DIR: this.options.marketConfigDir } : {}),
        ...(this.options.templateDir ? { POE2_TEMPLATE_DIR: this.options.templateDir } : {}),
        ...(worker ? { ELECTRON_RUN_AS_NODE: "1", POE2_STASH_DATA_ROOT: worker.dataRoot } : {}),
      },
    });
    this.child = child;
    this.childKind = kind;
    const forward = (chunk: unknown) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (line.trim()) this.emit({ kind: "log", line: line.trimEnd() });
      }
    };
    child.stdout?.on("data", forward);
    child.stderr?.on("data", forward);
    child.on("exit", (code) => {
      if (this.child !== child || this.stoppingChild === child) return;
      this.child = undefined;
      this.childKind = undefined;
      if (code !== 0) {
        this.state = { ...this.state, lastError: `${kind} exited ${code}` };
        this.emit({ kind: "error", message: `${kind} exited ${code}` });
      }
      this.setPhase("idle");
    });
    child.on("error", (error) => {
      if (this.child !== child || this.stoppingChild === child) return;
      this.child = undefined;
      this.childKind = undefined;
      this.state = { ...this.state, lastError: error.message };
      this.emit({ kind: "error", message: `${kind} could not start: ${error.message}` });
      this.setPhase("idle");
    });
    return { started: true };
  }

  stopScript(reason = "Stopped from the app"): boolean {
    const child = this.child;
    const kind = this.childKind;
    if (!child || !kind) return false;
    if (this.stoppingChild === child && this.treeStopPending) return true;
    if (kind.startsWith("value-dump")) {
      // The npx shell owns Node/tsx and both PowerShell input hosts. Killing
      // only that shell orphans live input workers. Ask Windows to terminate
      // this specific owned tree before allowing another run to start.
      if (!Number.isInteger(child.pid) || !child.pid || child.pid <= 0) {
        this.emit({ kind: "error", message: "Cannot stop dump valuation: its process ID is unavailable." });
        return false;
      }
      this.stoppingChild = child;
      this.treeStopPending = true;
      this.emit({ kind: "log", line: "Stopping dump valuation and its worker processes…" });
      execFile("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, error => {
        if (this.child !== child) return;
        this.treeStopPending = false;
        if (error) {
          const message = `Could not confirm dump valuation stopped: ${error.message}`;
          this.state = { ...this.state, lastError: message };
          this.emit({ kind: "error", message });
          // Stay busy instead of claiming the grandchildren have stopped.
          return;
        }
        this.stoppingChild = undefined;
        this.child = undefined;
        this.childKind = undefined;
        try { this.options.onScriptStopped?.(kind, reason); }
        catch (reportError) {
          this.emit({ kind: "error", message: `Input workers stopped, but the report could not be updated: ${String(reportError)}` });
        }
        this.setPhase("idle");
      });
    } else {
      child.kill();
      this.child = undefined;
      this.childKind = undefined;
      this.setPhase("idle");
    }
    return true;
  }

  constructor(private readonly options: StashTabAdminOptions) {
    this.templateDir =
      options.templateDir ?? path.join(options.root, "fixtures", "perception", "templates");
  }

  get status(): StashTabAdminStatus {
    return { ...this.state };
  }

  private emit(event: StashTabAdminEvent): void {
    this.options.emit?.(event);
  }

  private setPhase(phase: StashTabAdminStatus["phase"]): void {
    this.state = { ...this.state, phase, running: phase !== "idle" };
    this.emit({ kind: "phase", phase });
  }

  /** Runs `work` against a freshly started win-host, always closing it after. */
  private async withHost<T>(
    phase: StashTabAdminStatus["phase"],
    work: (kit: StashTabKit, drain: DrainKit, host: ReturnType<typeof startWinHost>) => Promise<T>,
  ): Promise<T> {
    if (this.options.canRun && !this.options.canRun()) {
      throw new Error("stash-tab-admin-blocked");
    }
    if (this.state.running) throw new Error("stash-tab-admin-busy");
    const host = startWinHost({ requestTimeoutMs: 30_000 });
    this.setPhase(phase);
    try {
      const rect = await host.send({ op: "rect" });
      if (!rect.ok) throw new Error("poe-window-not-found");
      const result = await work(new StashTabKit(host), new DrainKit(host, this.options.root, this.templateDir), host);
      this.state = { ...this.state, lastError: undefined };
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.state = { ...this.state, lastError: message };
      this.emit({ kind: "error", message });
      throw error;
    } finally {
      this.setPhase("idle");
      await host.close();
    }
  }

  /**
   * Walk the open folder row, recording each tab's grid geometry. Remove-only
   * tabs are reported but never selected.
   */
  async survey(folderName = "Gear"): Promise<StashTabSurveyResult> {
    return this.withHost("surveying", async (kit, drain, host) => {
      const opening = await kit.readStrip();
      const topRow = opening.top.map((entry) => entry.label);
      if (opening.folder.length === 0) {
        throw new Error(`folder-row-not-open:${folderName}`);
      }
      for (let i = 0; i < 16; i += 1) await kit.scrollStrip("folder", "left");

      const tabs: SurveyedStashTab[] = [];
      const seen = new Set<string>();
      for (let step = 0; step < 16; step += 1) {
        const strip = await kit.readStrip();
        let added = 0;
        for (const entry of strip.folder) {
          if (!entry.label || seen.has(entry.label)) continue;
          // The strip clips labels differently at each scroll offset; one tab
          // can arrive as "~price 5 exalted", "rice 5 exalted" and "exalted".
          if (tabs.some((known) => labelsSimilar(known.label, entry.label))) {
            seen.add(entry.label);
            continue;
          }
          seen.add(entry.label);
          added += 1;
          const tab = await this.inspect(kit, drain, host, entry, tabs.length, folderName);
          const twin = tabs.find(
            (known) =>
              known.gridCols !== undefined &&
              known.gridCols === tab.gridCols &&
              known.occupiedCells === tab.occupiedCells,
          );
          if (twin) continue;
          tabs.push(tab);
          this.emit({ kind: "tab", tab });
        }
        if (step > 0 && added === 0) break;
        await kit.scrollStrip("folder", "right");
      }
      this.state = { ...this.state, lastSurveyAt: new Date().toISOString() };
      return { folderName, topRow, tabs };
    });
  }

  private async inspect(
    _kit: StashTabKit,
    drain: DrainKit,
    host: { send(payload: Record<string, unknown>): Promise<unknown> },
    entry: StripEntry,
    index: number,
    folder: string,
  ): Promise<SurveyedStashTab> {
    const priced = looksPricedTabLabel(entry.label);
    const removeOnly = isRemoveOnlyTabLabel(entry.label);
    const base: SurveyedStashTab = {
      index,
      label: entry.label,
      folder,
      priced,
      removeOnly,
      editable: !priced && !removeOnly,
    };
    // Standing rule: never select a Remove-only tab, not even to measure it.
    if (removeOnly) return base;
    await host.send({ op: "click", x: entry.point.x, y: entry.point.y });
    await sleep(650);
    try {
      const snap = await drain.snapshot();
      return {
        ...base,
        ...(snap.facts.stashGridSize ? { gridCols: snap.facts.stashGridSize.cols } : {}),
        occupiedCells: snap.facts.occupiedStash.length,
      };
    } catch {
      return base;
    }
  }

  /** Pure planning step; safe to call without the game running. */
  plan(
    tabs: readonly SurveyedStashTab[],
    requireQuad = false,
    allowPricedTabs = false,
  ): { plan: StashTabPlan; errors: string[] } {
    // With the priced opt-in on, priced tabs become eligible destinations;
    // Remove-only tabs stay excluded either way.
    const editableLabels = tabs
      .filter((tab) => (allowPricedTabs ? !tab.removeOnly : tab.editable))
      .map((tab) => tab.label);
    const plan = buildGearTabPlan(tabs, { editableLabels, requireQuad, allowPricedTabs });
    return { plan, errors: validateStashTabPlan(plan, { allowPricedTabs }) };
  }

  /** Execute a validated plan. Refuses to start if validation still fails. */
  async apply(
    plan: StashTabPlan,
    options: { dryRun?: boolean; allowPricedTabs?: boolean } = {},
  ): Promise<StashTabApplyOutcome[]> {
    const errors = validateStashTabPlan(plan, { allowPricedTabs: options.allowPricedTabs });
    if (errors.length) throw new Error(`plan-invalid:${errors.join("; ")}`);
    return this.withHost("applying", async (kit) => {
      const outcomes: StashTabApplyOutcome[] = [];
      for (const { slot, targetLabel } of plan.assignments) {
        const entry = await kit.locate(targetLabel);
        if (!entry) {
          const outcome: StashTabApplyOutcome = {
            targetLabel,
            newName: slot.tabName,
            colour: slot.colour,
            applied: false,
            reason: "tab-not-found",
          };
          outcomes.push(outcome);
          this.emit({ kind: "applied", outcome });
          continue;
        }
        const result = await kit.applyTabIdentity(entry, slot.tabName, slot.colour, {
          ...options,
          expectedLabel: targetLabel,
        });
        const outcome: StashTabApplyOutcome = {
          targetLabel: result.before ?? targetLabel,
          newName: slot.tabName,
          colour: slot.colour,
          applied: result.applied,
          ...(result.reason ? { reason: result.reason } : {}),
        };
        outcomes.push(outcome);
        this.emit({ kind: "applied", outcome });
      }
      return outcomes;
    });
  }
}
