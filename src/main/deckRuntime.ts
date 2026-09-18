import { DECK_ACTIONS, type DeckActionId, type DeckButtonState, type DeckPreferences, type DeckStatus } from "../shared/deckActions.js";
import type { BagTriageService } from "./bagTriageService.js";
import type { AssistiveRunService } from "./assistiveRunService.js";
import type { StashSortService } from "./stashSortService.js";
import type { StashTabAdminService } from "./stashTabAdminService.js";
import type { CombatAssistService } from "./combatAssistService.js";
import type { VoiceTransferService } from "./voiceTransferService.js";
import type { PriceHelperService } from "./priceHelperService.js";
import type { ScannerRuntimeService } from "./scanRuntimeService.js";
import type { KillSwitch } from "../core/killSwitch.js";
import type { StashTabScriptKind } from "../shared/ipc.js";

export interface DeckServices {
  bag: BagTriageService; transfer: AssistiveRunService; sort: StashSortService;
  scripts: StashTabAdminService; combat: CombatAssistService; voice: VoiceTransferService;
  helper: PriceHelperService; scanner: ScannerRuntimeService; kill: KillSwitch;
  preferences(): DeckPreferences; dryRun(enabled: boolean): void;
  stop(): void; emergencyStop(): void; rearm(): void; navigate(route: string): void;
  evaluate(): unknown; refreshFeed(): unknown; reassess(): unknown;
}
const previews: Partial<Record<StashTabScriptKind, StashTabScriptKind>> = {
  "sort-inventory": "sort-inventory-dry",
  "sort-gear": "sort-gear-dry", "craft-gear": "craft-gear-dry", "shop-scan": "shop-scan-dry",
  "shop-buckets": "shop-buckets-dry", "shop-list": "shop-list-dry", "shop-apply": "shop-scan-dry",
  "shop-apply-step": "shop-scan-dry", renumber: "renumber-dry", "vendor-cycle": "vendor-cycle-dry",
};
export class DeckRuntime {
  private pending = new Set<DeckActionId>();
  private errors = new Map<DeckActionId, string>();
  private combatPaused = false;
  private lastWorkflow?: DeckActionId;
  private progress = new Map<string, { detail: string; count?: number }>();
  constructor(private readonly s: DeckServices) {}
  observe(source: "transfer" | "sort" | "script" | "scan", event: { message?: string; line?: string; traceCount?: number; completedMoves?: number }): void {
    this.progress.set(source, { detail: event.message ?? event.line ?? "Working", count: event.completedMoves ?? event.traceCount });
  }
  private workflow(action: string): boolean { return /^(rings|bag|transfer|sort|script|scan|tabs)\./.test(action) || ["combat.start", "combat.resume", "voice.listen", "helper.calibrate"].includes(action); }
  private busy(): boolean {
    const s = this.s;
    return s.bag.status.running || s.transfer.status.running || s.sort.status.running || s.scripts.status.running || s.scanner.status.running || s.combat.status.running || ["listening", "recognized", "transferring"].includes(s.voice.status.phase) || [...this.pending].some(a => this.workflow(a));
  }
  private active(action: DeckActionId): boolean {
    const s = this.s;
    if (this.pending.has(action)) return true;
    if (action.startsWith("rings.") || action.startsWith("bag.")) return s.bag.status.running && s.bag.status.stage === action.split(".")[1];
    if (action.startsWith("transfer.")) return s.transfer.status.running && this.lastWorkflow === action;
    if (action.startsWith("sort.")) return s.sort.status.running;
    if (action.startsWith("script.")) return s.scripts.status.running && this.lastWorkflow === action;
    if (action.startsWith("scan.")) return s.scanner.status.running && this.lastWorkflow === action;
    if (["combat.start", "combat.resume"].includes(action)) return s.combat.status.running;
    if (action === "voice.listen") return ["listening", "recognized", "transferring"].includes(s.voice.status.phase);
    if (action === "helper.start") return s.helper.status().running;
    return false;
  }
  private blocked(action: DeckActionId): string | undefined {
    const s = this.s, dry = s.preferences().dryRun;
    if (this.workflow(action)) {
      if (s.kill.isLatched()) return "Emergency stop latched. Explicitly rearm first.";
      if (this.busy()) return "A workflow is already active. Stop it before starting another.";
    }
    if (this.pending.has(action)) return "This command is already in progress.";
    if (/^(rings|bag)\./.test(action)) {
      if (dry && action.startsWith("bag.")) return "This bag stage has no no-input preview. Use Replay tools or explicitly disable Dry-run.";
      const issues = s.bag.refresh();
      if (!dry) return (action.startsWith("rings.") ? issues.gambleReadiness : issues.readiness)?.join(" ") || undefined;
    }
    if (action.startsWith("transfer.") && !s.transfer.status.gridsCalibrated) return "Calibrate bag and stash grids first.";
    if (action.startsWith("sort.") && !s.sort.status.calibrated) return "Calibrate bag, stash and search first.";
    if (action === "sort.execute") {
      if (dry) return "Dry-run is enabled. Use Preview stash sort.";
      if (!s.sort.status.last?.plan.executable) return "Create an executable stash sort preview first.";
    }
    if (dry && action.startsWith("script.") && !previews[action.slice(7) as StashTabScriptKind]) return "This script has no no-input preview. Open its tool to review, or explicitly disable Dry-run.";
    if (action === "safety.rearm" && this.busy()) return "Wait for every stopped worker to exit before rearming.";
    if (action === "safety.dry-off" && this.busy()) return "Stop the active workflow before changing execution mode.";
    if (action === "tabs.survey" && dry) return "The tab survey reads the live game. Disable Dry-run explicitly to run it.";
    return undefined;
  }
  status(): Omit<DeckStatus, "session"> {
    const s = this.s;
    const buttons = Object.fromEntries(DECK_ACTIONS.map(([id, , , detail]) => {
      const active = this.active(id), reason = active ? undefined : this.blocked(id);
      const error = this.errors.get(id);
      const button: DeckButtonState = { state: active ? "active" : reason ? "unavailable" : error ? "error" : "idle", detail: reason || error || detail };
      const progress = this.progress.get(id.split(".")[0]);
      if (active && progress) { button.detail = progress.detail; button.count = progress.count; }
      if (id === "safety.estop" && s.kill.isLatched()) { button.state = "active"; button.detail = "Input stopped and latched"; }
      if ((id === "safety.dry-on" && s.preferences().dryRun) || (id === "safety.dry-off" && !s.preferences().dryRun)) button.state = "active";
      if (id === "combat.pause" && this.combatPaused && !s.combat.status.running) button.state = "paused";
      if (id === "helper.prices" && s.helper.status().config.mode === "prices" || id === "helper.rumours" && s.helper.status().config.mode === "rumours" || id === "helper.debug" && s.helper.status().config.debug) button.state = "active";
      const module = id.slice(7) as "health" | "mana" | "unleash" | "verisium" | "sigilSequence";
      if (id.startsWith("combat.") && module in s.combat.status.config && s.combat.status.config[module]?.enabled) { button.state = "active"; button.detail = "Enabled setting; configure stops combat until explicitly restarted."; }
      if (id.startsWith("rings.") || id.startsWith("bag.")) {
        const bag = s.bag.status;
        if (bag.stage === id.split(".")[1]) {
          if (bag.phase === "error") { button.state = "error"; button.detail = bag.message; }
          if (active) { button.detail = bag.message; button.count = bag.sold ?? bag.verifiedDrops ?? bag.physicalItems; }
        }
      }
      if (id === "combat.start" || id === "combat.resume") { button.count = s.combat.status.actions; if (active || this.lastWorkflow === id) button.detail = s.combat.status.reason; }
      if (id.startsWith("helper.")) { button.detail = reason || error || s.helper.status().message || detail; if (id === "helper.start" && active) button.count = s.helper.status().lastRows?.length; }
      if (id === this.lastWorkflow && id.startsWith("script.") && s.scripts.status.lastError) { button.state = "error"; button.detail = s.scripts.status.lastError!; }
      return [id, button];
    })) as Record<DeckActionId, DeckButtonState>;
    return { version: 1, dryRun: s.preferences().dryRun, killLatched: s.kill.isLatched(), buttons };
  }
  execute(action: DeckActionId): unknown {
    const blocked = this.blocked(action); if (blocked) throw new Error(blocked);
    this.errors.delete(action);
    if (this.workflow(action)) this.lastWorkflow = action;
    try {
      const result = this.run(action);
      if (result instanceof Promise) {
        this.pending.add(action);
        return result.then(value => { this.checkResult(value); return value; }).catch(error => { this.errors.set(action, String(error)); throw error; }).finally(() => this.pending.delete(action));
      }
      this.checkResult(result); return result;
    } catch (error) { this.errors.set(action, String(error)); throw error; }
  }
  private checkResult(value: unknown): void {
    if (value && typeof value === "object") {
      const r = value as Record<string, unknown>;
      if (r.ok === false || r.started === false || r.phase === "error" || r.status === "failed") throw new Error(String(r.reason ?? r.error ?? r.message ?? "The service rejected the command."));
    }
  }
  private run(action: DeckActionId): unknown {
    const s = this.s, p = s.preferences(), id = action.split(".")[1];
    if (action.startsWith("open.")) { s.navigate(["dashboard", "shop", "items", "search", "builds"].includes(id) ? `/${id}` : `/tools/${id}`); return; }
    if (action.startsWith("rings.")) return s.bag.start(id as "gamble" | "cleanup", { dryRun: p.dryRun });
    if (action.startsWith("bag.")) return s.bag.start(id as "workflow" | "capture" | "identify" | "drop" | "reconcile");
    if (action.startsWith("transfer.")) return s.transfer.start({ kind: id as "empty" | "fill" | "two-cycle", dryRun: p.dryRun, wantedClasses: [], uniqueAcrossCycles: false, qaAcknowledged: true, allowlist: p.allowlist, actionsPerMinute: p.transferActionsPerMinute });
    if (action.startsWith("sort.")) return s.sort.start({ action: id as "preview" | "execute", planId: id === "execute" ? s.sort.status.last?.plan.id : undefined, qaAcknowledged: true, allowlist: p.allowlist, actionsPerMinute: p.sortActionsPerMinute, tabSafety: "writable-grid" });
    if (action.startsWith("script.")) return s.scripts.runScript(p.dryRun ? previews[id as StashTabScriptKind]! : id as StashTabScriptKind);
    if (action.startsWith("scan.")) return s.scanner.start({ gridKind: id as "inventory" | "stash-normal" | "stash-quad", dryRun: p.dryRun, qaAcknowledged: true, allowlist: p.allowlist, actionsPerMinute: p.transferActionsPerMinute });
    if (action.startsWith("combat.")) {
      if (id === "start" || id === "resume") { this.combatPaused = false; return s.combat.start().then(status => { if (!status.running) throw new Error(status.reason); return status; }); }
      if (id === "pause" || id === "stop") { this.combatPaused = id === "pause"; return s.combat.stop(id === "pause" ? "Paused from Stream Deck" : "Stopped from Stream Deck"); }
      const module = id as "health" | "mana" | "unleash" | "verisium" | "sigilSequence";
      const config = s.combat.status.config;
      return s.combat.configure({ ...config, [module]: { ...config[module], enabled: !config[module].enabled } });
    }
    if (action.startsWith("helper.")) {
      if (id === "prices" || id === "rumours") return s.helper.configure({ ...s.helper.status().config, mode: id });
      if (id === "debug") { const config = s.helper.status().config; return s.helper.configure({ ...config, debug: !config.debug }); }
      return s.helper[id as "start" | "stop" | "refresh" | "refreshRumours" | "calibrate"]();
    }
    switch (action) {
      case "tabs.survey": return s.scripts.survey();
      case "voice.listen": return s.voice.trigger("ui");
      case "voice.cancel": return s.voice.cancel("stream-deck");
      case "workflow.stop": return s.stop();
      case "safety.estop": return s.emergencyStop();
      case "safety.rearm": return s.rearm();
      case "safety.dry-on": s.stop(); return s.dryRun(true);
      case "safety.dry-off": return s.dryRun(false);
      case "item.evaluate": return s.evaluate();
      case "feed.refresh": return s.refreshFeed();
      case "valuation.reassess": return s.reassess();
      case "overlay.hide": return s.transfer.hideOverlay();
      default: throw new Error("Unregistered command");
    }
  }
}
