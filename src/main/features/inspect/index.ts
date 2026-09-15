/**
 * Feature module "inspect": the item insight overlay (Alt+I) and its map
 * warnings.
 *
 * SAFETY, in one paragraph: this feature sends no game input and makes no
 * network request. The hotkey reads the OS clipboard — the game's own
 * Ctrl+C on a hovered item — and analyses it locally against ranges the
 * price feed already learned. The one optional exception is
 * `settings.copyOnHotkey` (default OFF), which asks the audited chat-command
 * service for exactly one Ctrl+C through its kill-switch / foreground /
 * dry-run gates; this module never touches the input host itself. Links open
 * only on a click, only to two allowlisted hosts, and only after
 * `isAllowedInspectLink`.
 *
 * Registration order: after `overlay` and `hotkeys` (required), and the
 * client log / chat commands are looked up loosely so a missing foundation
 * degrades instead of failing registration.
 */

import {
  MAX_INSPECT_TEXT_LENGTH,
  inspectItemText,
  type InspectReport,
} from "../../../core/inspect.js";
import { isAllowedInspectLink } from "../../../core/inspectLinks.js";
import type { MapModSeverity } from "../../../core/inspectMapMods.js";
import { MOD_FAMILIES } from "../../../core/modKnowledge.js";
import { looksLikePoeItemText } from "../../../core/parseItem.js";
import { buildStatCatalogue, type StatCatalogue } from "../../../core/statIds.js";
import type { LearnedTiers } from "../../../core/tierLearning.js";
import type { AreaCategory } from "../../../core/clientLog.js";
import type { PriceTable } from "../../../core/priceTable.js";
import { DANGEROUS_MAP_MODS } from "../../../data/inspect/dangerousMapMods.js";
import type { NoticePayload } from "../../../shared/overlay.js";
import {
  DEFAULT_INSPECT_SETTINGS,
  INSPECT_HOTKEY_ACTION,
  INSPECT_PANEL_ID,
  INSPECT_PANEL_SIZE,
  INSPECT_SETTINGS_ID,
  normalizeInspectSettings,
  type DangerousMapModView,
  type InspectSettings,
  type InspectShowOutcome,
} from "../../../shared/inspect.js";
import type { FeatureContext, FeatureModule } from "../types.js";

declare module "../types.js" {
  interface FeatureServiceMap {
    inspect: InspectService;
  }
}

export interface InspectService {
  /** Analyse one item text with main's learned tiers, catalogue and area. */
  analyze(text: string): InspectReport | undefined;
  /** The last report shown (memory only — nothing is persisted). */
  last(): InspectReport | undefined;
  /** Show the panel for `text`, or for whatever is on the clipboard. */
  show(text?: string): Promise<InspectShowOutcome>;
  hide(): void;
}

export interface InspectModuleDeps {
  /** Injected in tests so the follow poll runs on fake timers. */
  timers?: {
    setInterval: (callback: () => void, ms: number) => unknown;
    clearInterval: (handle: unknown) => void;
  };
  /** How often the pinned panel re-reads the clipboard (default 1 s). */
  followPollMs?: number;
  /** Seam for the stat catalogue (default: the price feed's cached payload). */
  statCatalogue?: (ctx: FeatureContext) => StatCatalogue | undefined;
  now?: () => Date;
  /** Monotonic milliseconds for the copy-gesture guard (default `Date.now`). */
  monotonic?: () => number;
}

export const INSPECT_FOLLOW_POLL_MS = 1_000;

/**
 * The shortest gap between two audited Ctrl+C requests from the hotkey.
 * Electron's `globalShortcut` repeats while the accelerator is held, so one
 * sustained gesture would otherwise become a burst of real key events in
 * the game — the "one gesture, one input" rule (compliance R1). Only the
 * COPY is guarded: showing and hiding the panel is free, and debouncing
 * that would break the press-twice-to-close toggle.
 */
export const INSPECT_COPY_GUARD_MS = 500;

/** The one thing this module reads from the client log, typed loosely. */
interface ClientLogLike {
  status(): {
    area?: { areaId: string; level: number; info: { name: string; category: AreaCategory } };
  };
  on(kind: "area", callback: (event: unknown) => void): () => void;
}

/** The one thing this module may ask of chat commands (opt-in only). */
interface ChatCommandsLike {
  copyHoveredItem(request: {
    reason: string;
    source: "inspect";
  }): Promise<{ ok: boolean; text?: string; blockedBy?: string }>;
}

/**
 * Why no panel appeared. Three different things — an empty clipboard, a
 * paste far too big to be an item, and item text the analyser choked on —
 * so the user gets three different sentences instead of being told to copy
 * an item they just copied.
 */
type AnalysisOutcome =
  | { kind: "ok"; report: InspectReport }
  | { kind: "no-item-text" }
  | { kind: "text-too-large" }
  | { kind: "analysis-failed" };

const FAILURE_NOTICES: Record<Exclude<AnalysisOutcome["kind"], "ok">, string> = {
  "no-item-text": "Hover an item in game and press Ctrl+C first, then press the Inspect hotkey.",
  "text-too-large": "That clipboard text is far too large to be a copied item, so Inspect skipped it.",
  "analysis-failed": "Inspect could not read this item — the details are in the log.",
};

function failureNotice(kind: Exclude<AnalysisOutcome["kind"], "ok">): NoticePayload {
  return {
    title: "Inspect",
    body: FAILURE_NOTICES[kind],
    tone: kind === "analysis-failed" ? "warning" : "info",
    ttlMs: 4_000,
  };
}

export function createInspectModule(deps: InspectModuleDeps = {}): FeatureModule {
  const timers = deps.timers ?? {
    setInterval: (callback: () => void, ms: number) => setInterval(callback, ms),
    clearInterval: (handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>),
  };
  const followPollMs = deps.followPollMs ?? INSPECT_FOLLOW_POLL_MS;

  return {
    id: "inspect",
    register(ctx) {
      const settings = ctx.settings.namespace<InspectSettings>(
        INSPECT_SETTINGS_ID,
        normalizeInspectSettings,
      );
      const overlay = ctx.require("overlay");
      const hotkeys = ctx.require("hotkeys");
      // Optional foundations: looked up loosely so registration never
      // depends on their order (chatCommands/index.ts sets the precedent).
      const getService = ctx.get as unknown as (id: string) => unknown;
      const clientLog = () => getService("clientLog") as ClientLogLike | undefined;
      const chatCommands = () => getService("chatCommands") as ChatCommandsLike | undefined;

      let lastReport: InspectReport | undefined;
      let followHandle: unknown;
      let followFingerprint = "";
      let lastCopyAt = Number.NEGATIVE_INFINITY;
      const monotonic = deps.monotonic ?? (() => Date.now());

      let cachedPayload: unknown;
      let cachedCatalogue: StatCatalogue | undefined;

      function statCatalogue(): StatCatalogue | undefined {
        if (deps.statCatalogue) return deps.statCatalogue(ctx);
        let payload: unknown;
        try {
          payload = ctx.core?.priceFeed?.statsPayloadCached?.();
        } catch (error) {
          ctx.log({ feature: "inspect", level: "warn", message: "stat catalogue unavailable", detail: error });
          return undefined;
        }
        if (payload === undefined) return undefined;
        if (payload !== cachedPayload) {
          cachedPayload = payload;
          try {
            const built = buildStatCatalogue(payload, MOD_FAMILIES, ["explicit"]);
            cachedCatalogue = built.entryCount > 0 ? built : undefined;
          } catch (error) {
            ctx.log({ feature: "inspect", level: "warn", message: "stat catalogue unusable", detail: error });
            cachedCatalogue = undefined;
          }
        }
        return cachedCatalogue;
      }

      function priceTable(): PriceTable | undefined {
        try {
          return ctx.core?.itemIntelligence?.getPriceTable?.();
        } catch {
          // A broken price table must never break the hotkey: the report
          // simply comes back without its appraisal line.
          return undefined;
        }
      }

      function currentArea(): { id: string; name: string; category: AreaCategory; level: number } | undefined {
        try {
          const area = clientLog()?.status().area;
          if (!area) return undefined;
          return {
            id: area.areaId,
            name: area.info.name,
            category: area.info.category,
            level: area.level,
          };
        } catch {
          // The client log is best effort; the report just loses its context.
          return undefined;
        }
      }

      function learnedTiers(): LearnedTiers | undefined {
        try {
          return ctx.core?.priceFeed?.learnedTiers?.();
        } catch {
          // No learned store: the report falls back to hand thresholds.
          return undefined;
        }
      }

      /**
       * The "at 20 % quality" rows are a display choice, so the setting is
       * applied to the payload: the overlay panel gets a finished report and
       * has no settings of its own to consult.
       */
      function applyDisplaySettings(report: InspectReport, config: InspectSettings): InspectReport {
        if (config.showQualityNormalised) return report;
        const next: InspectReport = { ...report };
        if (next.weapon?.atQuality20) {
          const { atQuality20: _dropped, ...weapon } = next.weapon;
          next.weapon = weapon;
        }
        if (next.defences) {
          next.defences = {
            ...next.defences,
            entries: next.defences.entries.map(({ atQuality20: _unused, ...entry }) => entry),
          };
        }
        return next;
      }

      /**
       * Analysis with its failure mode kept: the hotkey needs to tell an
       * empty clipboard from item text that could not be read, and the
       * oversized-paste guard has to sit in front of the parser (the panel
       * re-runs this once a second while it follows the clipboard).
       */
      function analyzeDetailed(text: string): AnalysisOutcome {
        if (text.length > MAX_INSPECT_TEXT_LENGTH) {
          ctx.log({
            feature: "inspect",
            level: "info",
            message: `clipboard text too large to inspect (${text.length} characters)`,
          });
          return { kind: "text-too-large" };
        }
        if (!looksLikePoeItemText(text)) return { kind: "no-item-text" };
        try {
          const learned = learnedTiers();
          const catalogue = statCatalogue();
          const prices = priceTable();
          const area = currentArea();
          const config = settings.get();
          const report = inspectItemText(text, {
            ...(learned ? { learnedTiers: learned } : {}),
            ...(catalogue ? { statIds: catalogue } : {}),
            ...(prices ? { priceTable: prices } : {}),
            ...(area ? { area } : {}),
            mapModOverrides: config.mapModOverrides,
            ...(deps.now ? { now: deps.now } : {}),
          });
          if (!report) return { kind: "no-item-text" };
          return { kind: "ok", report: applyDisplaySettings(report, config) };
        } catch (error) {
          ctx.log({ feature: "inspect", level: "warn", message: "analysis failed", detail: error });
          return { kind: "analysis-failed" };
        }
      }

      function analyze(text: string): InspectReport | undefined {
        const outcome = analyzeDetailed(text);
        return outcome.kind === "ok" ? outcome.report : undefined;
      }

      function stopFollow(): void {
        if (followHandle === undefined) return;
        timers.clearInterval(followHandle);
        followHandle = undefined;
      }

      function publish(report: InspectReport): void {
        lastReport = report;
        followFingerprint = report.fingerprint;
        ctx.emit("inspect:report", report);
      }

      function followTick(): void {
        const config = settings.get();
        if (!config.followClipboardWhilePinned) {
          stopFollow();
          return;
        }
        let pinned = false;
        try {
          pinned = overlay.state().pinnedPanels.includes(INSPECT_PANEL_ID);
        } catch {
          // A torn-down overlay simply stops the poll.
        }
        if (!pinned) {
          stopFollow();
          return;
        }
        // Anything inside the interval that throws would surface as an
        // uncaught exception in main, so one tick's failure is contained:
        // the poll survives and the panel keeps the report it has.
        try {
          const text = ctx.clipboard.readText();
          if (!looksLikePoeItemText(text)) return;
          const report = analyze(text);
          if (!report || report.fingerprint === followFingerprint) return;
          overlay.update(INSPECT_PANEL_ID, report);
          publish(report);
        } catch (error) {
          ctx.log({ feature: "inspect", level: "warn", message: "the clipboard poll failed", detail: error });
        }
      }

      function startFollow(): void {
        if (followHandle !== undefined) return;
        if (!settings.get().followClipboardWhilePinned) return;
        followHandle = timers.setInterval(() => followTick(), followPollMs);
      }

      /**
       * The clipboard text to inspect. With `copyOnHotkey` on, one audited
       * Ctrl+C is requested from the chat-command service first (it owns
       * every gate); its failure falls back to whatever is on the clipboard.
       */
      async function itemTextForHotkey(): Promise<string> {
        const config = settings.get();
        if (config.copyOnHotkey) {
          const chat = chatCommands();
          const since = monotonic() - lastCopyAt;
          if (chat && since < INSPECT_COPY_GUARD_MS) {
            // A held accelerator repeats; one gesture must stay one input.
            ctx.log({
              feature: "inspect",
              level: "info",
              message: `copy-on-hotkey skipped: only ${Math.round(since)} ms since the last copy`,
            });
          } else if (chat) {
            lastCopyAt = monotonic();
            try {
              const outcome = await chat.copyHoveredItem({ reason: "inspect", source: "inspect" });
              if (outcome?.text && looksLikePoeItemText(outcome.text)) return outcome.text;
              if (outcome && !outcome.ok) {
                ctx.log({
                  feature: "inspect",
                  level: "info",
                  message: "copy-on-hotkey was blocked; using the clipboard as it is",
                  detail: outcome.blockedBy,
                });
              }
            } catch (error) {
              ctx.log({ feature: "inspect", level: "warn", message: "copy-on-hotkey failed", detail: error });
            }
          }
        }
        return ctx.clipboard.readText();
      }

      async function show(text?: string): Promise<InspectShowOutcome> {
        const raw = text ?? (await itemTextForHotkey());
        const outcome = analyzeDetailed(raw);
        if (outcome.kind !== "ok") {
          await overlay.show("notice", { anchor: "cursor", payload: failureNotice(outcome.kind) });
          ctx.log({ feature: "inspect", level: "info", message: `nothing to inspect: ${outcome.kind}` });
          return { shown: false, reason: outcome.kind };
        }
        const report = outcome.report;
        const config = settings.get();
        if (
          overlay.isVisible(INSPECT_PANEL_ID) &&
          lastReport &&
          lastReport.fingerprint === report.fingerprint &&
          lastReport.textKind === report.textKind
        ) {
          overlay.hide(INSPECT_PANEL_ID);
          stopFollow();
          return { shown: false, hidden: true, fingerprint: report.fingerprint };
        }
        if (overlay.isVisible(INSPECT_PANEL_ID)) {
          // Already on screen: swap the payload instead of re-showing, so a
          // panel the user pinned somewhere keeps the place they put it
          // (`show` recomputes the position from the anchor every time).
          overlay.update(INSPECT_PANEL_ID, report);
        } else {
          await overlay.show(INSPECT_PANEL_ID, {
            anchor: config.anchor,
            payload: report,
            width: INSPECT_PANEL_SIZE.width,
            height: INSPECT_PANEL_SIZE.height,
          });
        }
        publish(report);
        startFollow();
        return { shown: true, fingerprint: report.fingerprint };
      }

      function hide(): void {
        overlay.hide(INSPECT_PANEL_ID);
        stopFollow();
      }

      const service: InspectService = {
        analyze,
        last: () => lastReport,
        show,
        hide,
      };
      ctx.provide("inspect", service);

      ctx.handle("inspect:analyze", (text: string) => analyze(String(text ?? "")) ?? null);
      ctx.handle("inspect:show", (text?: string) =>
        show(typeof text === "string" && text.length > 0 ? text : undefined),
      );
      ctx.handle("inspect:hide", () => {
        hide();
      });
      ctx.handle("inspect:last", () => lastReport ?? null);
      ctx.handle("inspect:open-link", async (url: string) => {
        if (!isAllowedInspectLink(url)) {
          ctx.log({ feature: "inspect", level: "warn", message: "refused a link outside the allowlist", detail: url });
          return { ok: false, reason: "not-allowed" as const };
        }
        try {
          await ctx.openExternal(url);
          return { ok: true };
        } catch (error) {
          ctx.log({ feature: "inspect", level: "warn", message: "the link could not be opened", detail: error });
          return { ok: false, reason: "failed" as const };
        }
      });
      ctx.handle("inspect:map-mods", (): DangerousMapModView[] => {
        const overrides: Record<string, MapModSeverity | "ignore"> = settings.get().mapModOverrides;
        return DANGEROUS_MAP_MODS.map((mod) => ({
          ...mod,
          effectiveSeverity: overrides[mod.id] ?? mod.severity,
        }));
      });

      const unbindHotkey = hotkeys.contribute({
        ...INSPECT_HOTKEY_ACTION,
        run: async () => {
          await show();
        },
      });

      const stopPanelEvents = overlay.onPanelEvent((event) => {
        if (event.panelId !== INSPECT_PANEL_ID) return;
        if (event.kind === "shown") startFollow();
        if (event.kind === "hidden" || event.kind === "closed-by-user") stopFollow();
      });

      const stopSettings = settings.onChange((next) => {
        // Symmetric on purpose: turning the poll back on while the panel is
        // already pinned has to restart it, or the setting looks broken
        // until the panel is closed and re-opened.
        if (!next.followClipboardWhilePinned) stopFollow();
        else if (overlay.isVisible(INSPECT_PANEL_ID)) startFollow();
      });

      ctx.log({
        feature: "inspect",
        level: "info",
        message: `inspect ready (${DANGEROUS_MAP_MODS.length} map modifiers rated, defaults ${
          DEFAULT_INSPECT_SETTINGS.anchor
        })`,
      });

      return {
        dispose: () => {
          stopFollow();
          stopPanelEvents();
          stopSettings();
          unbindHotkey();
        },
      };
    },
  };
}

export const inspectModule: FeatureModule = createInspectModule();
