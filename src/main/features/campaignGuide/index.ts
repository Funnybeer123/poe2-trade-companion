/**
 * Feature module "campaignGuide" (package P8): the levelling companion.
 *
 * Main owns the bundled route file, the user's corrections and progress (one
 * settings namespace), the current area (from the clientLog foundation) and
 * the overlay panel that appears by itself while the player is in the
 * campaign. It sends NO game input and makes NO network request: the only
 * outward action is handing a poe2wiki URL to the OS browser on a click.
 *
 * WHY the views are split in two: `campaign:route` is the big merged route
 * (acts, areas, objectives) and changes only when the user edits something;
 * `campaign:state` is a handful of fields recomputed on every area change.
 * Walking through a hundred areas therefore costs a hundred small pushes
 * plus at most one route pull per mounted consumer, never a hundred copies
 * of the whole route to every window (§4.1).
 */
import {
  CAMPAIGN_IMPORT_MAX_BYTES,
  CAMPAIGN_PATCH_OPS,
  applyCustomisePatch,
  emptyCampaignRoute,
  experienceBand,
  exportMergedRoute,
  importRouteAsCustomisations,
  mergeCampaignRoute,
  nextStep,
  normalizeCampaignGuideSettings,
  parseCampaignRoute,
  recordVisit,
  resolveArea,
  routeAffectingSettingsChanged,
  wikiUrl,
  WIKI_HOST,
  type CampaignCustomisePatch,
  type CampaignGuideSettings,
  type CampaignRouteFile,
  type MergedRoute,
} from "../../../core/campaignGuide.js";
import type { ClientLogEvent } from "../../../core/clientLog.js";
import { CAMPAIGN_PANEL_ID } from "../../../shared/campaignGuide.js";
import type {
  CampaignBundledInfo,
  CampaignPanelPayload,
  CampaignRouteView,
  CampaignStateView,
} from "../../../shared/campaignGuide.js";
import type { SettingsNamespace } from "../../settingsStore.js";
import type { OverlayService } from "../../overlayWindow.js";
import type { ClientLogService } from "../clientLog/index.js";
import type { FeatureContext, FeatureModule } from "../types.js";
import { readBundledRoute, routeCandidates } from "./routeStore.js";

export { CAMPAIGN_ROUTE_RELATIVE, readBundledRoute, routeCandidates } from "./routeStore.js";

const PANEL_ID = CAMPAIGN_PANEL_ID;
const PANEL_WIDTH = 380;
const PANEL_HEIGHT = 520;
const DEFAULT_RESCAN_BYTES = 16 * 1024 * 1024;
const SEED_LIMIT = 500;

export interface CampaignGuideModuleDeps {
  /** Injected in tests; defaults to reading the bundled `route.json`. */
  routeSource?: (ctx: FeatureContext) => { text?: string; path: string };
  now?: () => Date;
  rescanBytes?: number;
}

export interface CampaignGuideHooks {
  settings: SettingsNamespace<CampaignGuideSettings>;
  clientLog: ClientLogService;
  /** Optional: the state still works without an overlay window (tests, headless). */
  overlay?: OverlayService;
  emit(channel: "campaign:state" | "campaign:route-changed", payload: unknown): void;
  clipboard: FeatureContext["clipboard"];
  openExternal(url: string): Promise<void>;
  log(level: "info" | "warn" | "error", message: string, detail?: unknown): void;
  now(): Date;
  route: CampaignRouteFile;
  bundled: CampaignBundledInfo;
  rescanBytes: number;
}

type AreaEvent = Extract<ClientLogEvent, { kind: "area" }>;
type LevelUpEvent = Extract<ClientLogEvent, { kind: "level-up" }>;

function isPatch(value: unknown): value is CampaignCustomisePatch {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const op = (value as { op?: unknown }).op;
  return typeof op === "string" && (CAMPAIGN_PATCH_OPS as readonly string[]).includes(op);
}

export class CampaignGuideService {
  private readonly hooks: CampaignGuideHooks;
  private mergedCache: { key: CampaignGuideSettings; value: MergedRoute } | undefined;
  private lastArea: AreaEvent | undefined;
  private character: { name?: string; className?: string; level: number; seenAt?: string } | undefined;
  private autoShown = false;
  private dismissedForAreaId: string | undefined;
  private progressRevision = 1;
  private importIssues: string[] | undefined;
  /** Our own settings writes must not re-enter the onChange fan-out. */
  private selfWrite = false;
  /** Fences everything that is already queued: nothing may act after dispose(). */
  private disposed = false;
  private chain: Promise<void> = Promise.resolve();
  private readonly stops: Array<() => void> = [];

  constructor(hooks: CampaignGuideHooks) {
    this.hooks = hooks;
  }

  // ---- lifecycle ----------------------------------------------------------

  start(): void {
    const status = this.hooks.clientLog.status();
    if (status.area) this.lastArea = status.area;
    if (status.character) this.character = { ...status.character };
    this.seedVisited();
    this.stops.push(
      this.hooks.clientLog.on("area", (event) => {
        void this.onArea(event as AreaEvent);
      }),
    );
    this.stops.push(
      this.hooks.clientLog.on("level-up", (event) => {
        this.onLevelUp(event as LevelUpEvent);
      }),
    );
    const overlay = this.hooks.overlay;
    if (overlay) {
      this.stops.push(
        overlay.onPanelEvent((event) => {
          if (event.panelId !== PANEL_ID) return;
          if (event.kind !== "closed-by-user" && event.kind !== "hidden") return;
          this.dismissedForAreaId = this.lastArea?.areaId;
          this.autoShown = false;
          this.emitState();
        }),
      );
    }
    this.stops.push(
      this.hooks.settings.onChange((next, previous) => {
        if (this.selfWrite) return;
        this.mergedCache = undefined;
        // An external settings:set (the Guide settings section) may change the
        // filters or the anchor — but only then is the ~150 KB route push
        // worth it (§4.1). A progress-shaped write from somewhere else bumps
        // the revision instead, so consumers pull the route themselves.
        if (routeAffectingSettingsChanged(next, previous)) {
          this.hooks.emit("campaign:route-changed", this.routeView());
        } else if (JSON.stringify(next.progress) !== JSON.stringify(previous.progress)) {
          this.progressRevision += 1;
        }
        this.emitState();
      }),
    );
  }

  dispose(): void {
    this.disposed = true;
    for (const stop of this.stops.splice(0)) {
      try {
        stop();
      } catch {
        // A listener that already went away must not break disposal.
      }
    }
  }

  // ---- views --------------------------------------------------------------

  private merged(): MergedRoute {
    const settings = this.hooks.settings.get();
    if (this.mergedCache && this.mergedCache.key === settings) return this.mergedCache.value;
    const value = mergeCampaignRoute(this.hooks.route, settings);
    this.mergedCache = { key: settings, value };
    return value;
  }

  routeView(): CampaignRouteView {
    return {
      merged: this.merged(),
      bundled: this.hooks.bundled,
      settings: this.hooks.settings.get(),
      progressRevision: this.progressRevision,
      ...(this.importIssues ? { importIssues: this.importIssues } : {}),
      generatedAt: this.hooks.now().toISOString(),
    };
  }

  stateView(): CampaignStateView {
    const settings = this.hooks.settings.get();
    const merged = this.merged();
    const status = this.hooks.clientLog.status();
    const view: CampaignStateView = {
      overlay: { visible: false, autoShown: false },
      progressRevision: this.progressRevision,
      clientLog: { watching: status.watching, ...(status.error ? { error: status.error } : {}) },
      generatedAt: this.hooks.now().toISOString(),
    };

    if (this.lastArea) {
      const resolution = resolveArea(merged, this.lastArea.areaId, this.lastArea.info);
      view.current = {
        ...resolution,
        observedLevel: this.lastArea.level,
        at: this.lastArea.at,
        seed: this.lastArea.seed,
      };
      if (resolution.area) view.next = nextStep(merged, resolution.area, settings);
    }

    const override = settings.characterLevelOverride;
    if (override !== null) {
      view.character = {
        ...(this.character?.name ? { name: this.character.name } : {}),
        ...(this.character?.className ? { className: this.character.className } : {}),
        level: override,
        ...(this.character?.seenAt ? { seenAt: this.character.seenAt } : {}),
        source: "override",
      };
    } else if (this.character) {
      view.character = { ...this.character, source: "log" };
    }

    // Only route areas get an estimate: comparing the character level with a
    // hideout's or a map's instance level would publish a red "45 levels below
    // this area" warning for standing in town.
    if (
      view.character &&
      view.current &&
      view.current.kind !== "outside" &&
      view.current.observedLevel > 0
    ) {
      view.experience = experienceBand(view.character.level, view.current.observedLevel);
    }

    // isVisible() is the source of truth: the overlay's PoE-exit sweep deletes
    // panel records WITHOUT a panel event, so a cached flag would lie.
    const visible = this.hooks.overlay?.isVisible(PANEL_ID) ?? false;
    if (!visible) this.autoShown = false;
    view.overlay = {
      visible,
      autoShown: this.autoShown && visible,
      ...(this.dismissedForAreaId ? { dismissedForAreaId: this.dismissedForAreaId } : {}),
    };
    return view;
  }

  private emitState(): void {
    this.hooks.emit("campaign:state", this.stateView());
  }

  // ---- settings writes ----------------------------------------------------

  private write(next: CampaignGuideSettings): void {
    // Teardown must never write companion-settings.json.
    if (this.disposed) return;
    this.selfWrite = true;
    try {
      this.hooks.settings.set(() => next);
    } finally {
      this.selfWrite = false;
      this.mergedCache = undefined;
    }
  }

  private seedVisited(): void {
    const events = this.hooks.clientLog.recent("area", SEED_LIMIT) as AreaEvent[];
    if (!events.length) return;
    let settings = this.hooks.settings.get();
    let changed = false;
    for (const event of events) {
      const result = recordVisit(settings, event.areaId, event.at, this.hooks.route);
      if (result.changed) {
        settings = result.settings;
        changed = true;
      }
    }
    if (!changed) return;
    this.progressRevision += 1;
    this.write(settings);
  }

  // ---- channels -----------------------------------------------------------

  customise(patch: unknown): CampaignRouteView {
    if (!isPatch(patch)) throw new Error("campaign-patch-object-required");
    const result = applyCustomisePatch(
      this.hooks.settings.get(),
      patch,
      this.hooks.route,
      () => this.hooks.now().getTime(),
    );
    if (result.issue) throw new Error(`campaign-patch-rejected:${result.issue}`);
    const progressOnly = patch.op === "set-done" || (patch.op === "reset" && patch.what === "progress");
    this.importIssues = undefined;
    this.progressRevision += 1;
    this.write(result.settings);
    const view = this.routeView();
    if (!progressOnly) this.hooks.emit("campaign:route-changed", view);
    this.emitState();
    return view;
  }

  importRoute(json: string, mode: "replace-customisations" | "merge"): CampaignRouteView {
    if (typeof json !== "string") throw new Error("campaign-import-string-required");
    // "replace-customisations" wipes every note, edit and custom area, so it is
    // never what a missing or mistyped argument means.
    if (mode !== "merge" && mode !== "replace-customisations") {
      throw new Error("campaign-import-bad-mode");
    }
    if (Buffer.byteLength(json, "utf8") > CAMPAIGN_IMPORT_MAX_BYTES) {
      throw new Error("campaign-import-too-large");
    }
    const parsed = parseCampaignRoute(json);
    const settings = this.hooks.settings.get();
    const result = importRouteAsCustomisations(
      parsed.route,
      this.hooks.route,
      settings.customisations,
      mode,
    );
    this.write({ ...settings, customisations: result.customisations });
    this.importIssues = [...parsed.issues, ...result.issues];
    this.hooks.log("info", "campaign route imported", {
      areas: result.areas,
      objectives: result.objectives,
      issues: this.importIssues.length,
    });
    const view = this.routeView();
    this.hooks.emit("campaign:route-changed", view);
    this.emitState();
    return view;
  }

  exportRoute(): { json: string; copied: boolean } {
    const json = exportMergedRoute(this.merged(), this.hooks.route);
    let copied = false;
    try {
      this.hooks.clipboard.writeText(json);
      copied = true;
    } catch (error) {
      this.hooks.log("warn", "campaign route export could not reach the clipboard", error);
    }
    return { json, copied };
  }

  setCharacterLevel(level: number | null): CampaignStateView {
    const settings = this.hooks.settings.get();
    const value =
      level === null || level === undefined
        ? null
        : Math.min(100, Math.max(1, Math.round(Number(level) || 0)));
    this.write({ ...settings, characterLevelOverride: value });
    this.emitState();
    return this.stateView();
  }

  async rescanLevel(): Promise<CampaignStateView> {
    try {
      await this.hooks.clientLog.replayTail(this.hooks.rescanBytes);
    } catch (error) {
      this.hooks.log("warn", "campaign guide could not rescan Client.txt", error);
    }
    const status = this.hooks.clientLog.status();
    if (status.character) this.character = { ...status.character };
    if (status.area) this.lastArea = status.area;
    this.seedVisited();
    this.emitState();
    return this.stateView();
  }

  private panelPayload(areaId: string | undefined, reason: CampaignPanelPayload["reason"]): CampaignPanelPayload {
    return {
      ...(areaId ? { areaId } : {}),
      compact: this.hooks.settings.get().overlayCompact,
      reason,
    };
  }

  /**
   * Serialises every overlay command with the area events. `overlay.show()`
   * awaits the window before it records the panel, so `isVisible()` stays
   * false for that whole window — two overlapping calls (hotkey auto-repeat, a
   * double click, an area event mid-show) would otherwise both call show().
   */
  private run<T>(task: () => Promise<T> | T): Promise<T> {
    const result = this.chain.then(() => task());
    this.chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  showOverlay(
    areaId?: string,
    reason: CampaignPanelPayload["reason"] = "desktop",
  ): Promise<CampaignStateView> {
    return this.run(() => this.doShowOverlay(areaId, reason));
  }

  hideOverlay(): Promise<CampaignStateView> {
    return this.run(() => this.doHideOverlay());
  }

  toggleOverlay(): Promise<CampaignStateView> {
    return this.run(() => {
      const overlay = this.hooks.overlay;
      if (!overlay) return this.stateView();
      if (overlay.isVisible(PANEL_ID)) return this.doHideOverlay();
      return this.doShowOverlay(undefined, "hotkey");
    });
  }

  private async doShowOverlay(
    areaId?: string,
    reason: CampaignPanelPayload["reason"] = "desktop",
  ): Promise<CampaignStateView> {
    const overlay = this.hooks.overlay;
    if (!overlay || this.disposed) return this.stateView();
    const settings = this.hooks.settings.get();
    const resolved =
      areaId ??
      (this.lastArea ? resolveArea(this.merged(), this.lastArea.areaId, this.lastArea.info).normalizedId : undefined);
    const payload = this.panelPayload(resolved, reason);
    if (overlay.isVisible(PANEL_ID)) {
      // Never re-show a visible panel: show() re-resolves the position and
      // would yank a panel the user dragged.
      overlay.update(PANEL_ID, payload);
    } else {
      await overlay.show(PANEL_ID, {
        anchor: settings.overlayAnchor,
        payload,
        pinned: true,
        focus: false,
        width: PANEL_WIDTH,
        height: PANEL_HEIGHT,
      });
      this.autoShown = reason === "auto";
    }
    this.dismissedForAreaId = undefined;
    this.emitState();
    return this.stateView();
  }

  private doHideOverlay(): CampaignStateView {
    this.hooks.overlay?.hide(PANEL_ID);
    this.autoShown = false;
    this.dismissedForAreaId = this.lastArea?.areaId;
    this.emitState();
    return this.stateView();
  }

  async openWiki(areaId: string): Promise<{ opened: boolean; url?: string }> {
    const area = this.merged().areaIndex[String(areaId)];
    if (!area) return { opened: false };
    const url = wikiUrl(area);
    if (!url) return { opened: false };
    // The URL is built from user-editable text, so the final string is
    // re-checked here rather than trusting the builder's inputs.
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" || parsed.host !== WIKI_HOST || !parsed.pathname.startsWith("/wiki/")) {
        return { opened: false };
      }
    } catch {
      return { opened: false };
    }
    await this.hooks.openExternal(url);
    return { opened: true, url };
  }

  // ---- log subscriptions --------------------------------------------------

  /** Serialised through the same chain as the overlay commands (see `run`). */
  onArea(event: AreaEvent): Promise<void> {
    return this.run(() => this.handleArea(event)).catch((error) => {
      this.hooks.log("warn", "campaign guide could not handle an area event", error);
    });
  }

  private async handleArea(event: AreaEvent): Promise<void> {
    // A queued event must not show a panel or write settings for a feature
    // that was disposed while an earlier show() was still awaiting.
    if (this.disposed) return;
    this.lastArea = event;
    const settings = this.hooks.settings.get();
    const visit = recordVisit(settings, event.areaId, event.at, this.hooks.route);
    if (visit.changed) {
      this.progressRevision += 1;
      this.write(visit.settings);
    }
    const merged = this.merged();
    const resolution = resolveArea(merged, event.areaId, event.info);
    if (this.dismissedForAreaId && this.dismissedForAreaId !== event.areaId) {
      this.dismissedForAreaId = undefined;
    }

    const overlay = this.hooks.overlay;
    const visible = overlay?.isVisible(PANEL_ID) ?? false;
    if (!visible) this.autoShown = false;

    const current = this.hooks.settings.get();
    if (resolution.kind !== "outside") {
      if (overlay && !this.disposed && current.autoShowInCampaign && this.dismissedForAreaId !== event.areaId) {
        const payload = this.panelPayload(resolution.normalizedId, "auto");
        if (visible) {
          overlay.update(PANEL_ID, payload);
        } else {
          await overlay.show(PANEL_ID, {
            anchor: current.overlayAnchor,
            payload,
            pinned: true,
            focus: false,
            width: PANEL_WIDTH,
            height: PANEL_HEIGHT,
          });
          this.autoShown = true;
        }
      }
    } else if (overlay && this.autoShown && current.hideOutsideCampaign && visible) {
      overlay.hide(PANEL_ID);
      this.autoShown = false;
    }
    this.emitState();
  }

  onLevelUp(event: LevelUpEvent): void {
    this.character = {
      name: event.character,
      className: event.className,
      level: event.level,
      seenAt: event.at,
    };
    this.emitState();
  }
}

function describeBundled(text: string | undefined, path: string): {
  route: CampaignRouteFile;
  bundled: CampaignBundledInfo;
} {
  if (typeof text !== "string") {
    return {
      route: emptyCampaignRoute(),
      bundled: {
        source: "missing",
        path,
        issues: [`route.json was not found at ${path}`],
        areaCount: 0,
        updatedAt: "",
      },
    };
  }
  const parsed = parseCampaignRoute(text);
  const areaCount = parsed.route.acts.reduce((total, act) => total + act.areas.length, 0);
  return {
    route: parsed.route,
    bundled: {
      source: "file",
      path,
      issues: parsed.issues,
      areaCount,
      updatedAt: parsed.route.updatedAt,
    },
  };
}

export function createCampaignGuideModule(deps: CampaignGuideModuleDeps = {}): FeatureModule {
  return {
    id: "campaignGuide",
    register(ctx: FeatureContext) {
      const settings = ctx.settings.namespace<CampaignGuideSettings>(
        "campaign-guide",
        normalizeCampaignGuideSettings,
      );
      const source = deps.routeSource
        ? deps.routeSource(ctx)
        : readBundledRoute(routeCandidates(ctx.repoRoot, ctx.appPath));
      const { route, bundled } = describeBundled(source.text, source.path);
      if (bundled.source === "missing") {
        ctx.log({
          feature: "campaignGuide",
          level: "warn",
          message: "bundled campaign route not found",
          detail: { path: bundled.path },
        });
      }

      const service = new CampaignGuideService({
        settings,
        clientLog: ctx.require("clientLog"),
        overlay: ctx.get("overlay"),
        emit: (channel, payload) => ctx.emit(channel, payload),
        clipboard: ctx.clipboard,
        openExternal: (url) => ctx.openExternal(url),
        log: (level, message, detail) => ctx.log({ feature: "campaignGuide", level, message, detail }),
        now: deps.now ?? (() => new Date()),
        route,
        bundled,
        rescanBytes: deps.rescanBytes ?? DEFAULT_RESCAN_BYTES,
      });

      ctx.handle("campaign:route", () => service.routeView());
      ctx.handle("campaign:state", () => service.stateView());
      ctx.handle("campaign:customise", (patch: unknown) => service.customise(patch));
      ctx.handle("campaign:set-character-level", (level: number | null) =>
        service.setCharacterLevel(level),
      );
      ctx.handle("campaign:rescan-level", () => service.rescanLevel());
      ctx.handle("campaign:show-overlay", (areaId?: string) =>
        service.showOverlay(typeof areaId === "string" && areaId ? areaId : undefined, "desktop"),
      );
      ctx.handle("campaign:hide-overlay", () => service.hideOverlay());
      ctx.handle("campaign:toggle-overlay", () => service.toggleOverlay());
      ctx.handle("campaign:export", () => service.exportRoute());
      ctx.handle("campaign:import", (json: string, mode: "replace-customisations" | "merge") =>
        service.importRoute(json, mode),
      );
      ctx.handle("campaign:open-wiki", (areaId: string) => service.openWiki(String(areaId)));

      const stopHotkey = ctx.require("hotkeys").contribute({
        id: "campaign.toggle",
        label: "Campaign guide",
        detail: "Toggle the campaign guide overlay panel for the current area.",
        group: "Overlay",
        defaultAccelerator: "Alt+G",
        // HotkeyAction.run is () => void | Promise<void>; returning the state
        // view would not be assignable.
        run: async () => {
          await service.toggleOverlay();
        },
      });

      service.start();
      return {
        dispose: () => {
          stopHotkey();
          service.dispose();
        },
      };
    },
  };
}

export const campaignGuideModule: FeatureModule = createCampaignGuideModule();

/** Channel ids this module registers, in the order the tests assert them. */
export const CAMPAIGN_CHANNELS: readonly string[] = [
  "campaign:route",
  "campaign:state",
  "campaign:customise",
  "campaign:set-character-level",
  "campaign:rescan-level",
  "campaign:show-overlay",
  "campaign:hide-overlay",
  "campaign:toggle-overlay",
  "campaign:export",
  "campaign:import",
  "campaign:open-wiki",
];

export { normalizeCampaignGuideSettings };
