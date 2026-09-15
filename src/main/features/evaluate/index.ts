/**
 * Feature module "evaluate": the price-check overlay.
 *
 * register() wires the settings namespace, the service, the eleven
 * `evaluate:*` channels, two hotkey actions and the overlay panel. It owns
 * NO game input of its own — the single Ctrl+C goes through the
 * chat-commands service (`copyHoveredItem`), the one audited capture path
 * Evaluate and Inspect share.
 */
import {
  DEFAULT_EVALUATE_SETTINGS,
  EVALUATE_CLIPBOARD_HOTKEY_ID,
  EVALUATE_HOTKEY_ID,
  EVALUATE_PANEL_ID,
  EVALUATE_SETTINGS_ID,
  normalizeEvaluateSettings,
  type EvaluateCopyKind,
  type EvaluateOpenFailure,
  type EvaluateOpenInput,
  type EvaluateQueryState,
  type EvaluateSession,
  type EvaluateSettings,
} from "../../../shared/evaluate.js";
import type { EvaluateProfileId } from "../../../core/tradeQuery.js";
import type { ChatCopyOutcome } from "../../../shared/chatCommands.js";
import type { NoticePayload } from "../../../shared/overlay.js";
import type { FeatureContext, FeatureModule } from "../types.js";
import { EvaluateService, type EvaluateServiceOptions } from "./service.js";

export { EvaluateService, EVALUATE_STAT_TYPES } from "./service.js";

/** Panel geometry; the integrator's `panels.ts` line uses the same numbers. */
export const EVALUATE_PANEL_SIZE = { width: 620, height: 560 } as const;

export interface EvaluateModuleDeps {
  /** Test seam: the audited Ctrl+C. Defaults to chatCommands.copyHoveredItem. */
  capture?: EvaluateServiceOptions["capture"];
}

function openInputFrom(raw: unknown): EvaluateOpenInput {
  const source = (typeof raw === "object" && raw !== null ? raw : {}) as Partial<EvaluateOpenInput>;
  const kind = source.source;
  return {
    ...(typeof source.text === "string" ? { text: source.text } : {}),
    source:
      kind === "hotkey" || kind === "clipboard" || kind === "item-log" || kind === "paste"
        ? kind
        : "paste",
    ...(typeof source.autoSearch === "boolean" ? { autoSearch: source.autoSearch } : {}),
    ...(typeof source.showOverlay === "boolean" ? { showOverlay: source.showOverlay } : {}),
  };
}

/** EvaluateSession also has an optional `error`, so `reason` is the tell. */
function isOpenFailure(
  result: EvaluateSession | EvaluateOpenFailure,
): result is EvaluateOpenFailure {
  return typeof (result as EvaluateOpenFailure).reason === "string";
}

function copyRequestFrom(raw: unknown): { kind: EvaluateCopyKind; listingId?: string } {
  const source = (typeof raw === "object" && raw !== null ? raw : {}) as {
    kind?: unknown;
    listingId?: unknown;
  };
  const kinds: readonly EvaluateCopyKind[] = ["note", "b/o", "whisper", "query-url", "item"];
  const kind = kinds.includes(source.kind as EvaluateCopyKind) ? (source.kind as EvaluateCopyKind) : "item";
  return {
    kind,
    ...(typeof source.listingId === "string" ? { listingId: source.listingId } : {}),
  };
}

export function createEvaluateModule(deps: EvaluateModuleDeps = {}): FeatureModule {
  return {
    id: "evaluate",
    register(ctx: FeatureContext) {
      const settings = ctx.settings.namespace<EvaluateSettings>(
        EVALUATE_SETTINGS_ID,
        (raw) => normalizeEvaluateSettings(raw).value,
      );
      const issues = normalizeEvaluateSettings(settings.get()).issues;
      if (issues.length > 0) {
        ctx.log({ feature: "evaluate", level: "warn", message: "settings sanitized", detail: issues });
      }

      const overlay = ctx.require("overlay");
      const hotkeys = ctx.require("hotkeys");
      const chat = ctx.require("chatCommands");

      const capture: EvaluateServiceOptions["capture"] =
        deps.capture ??
        (() =>
          chat.copyHoveredItem({
            reason: "evaluate hovered item",
            source: "evaluate",
          }) as Promise<ChatCopyOutcome>);

      const service = new EvaluateService({
        priceFeed: ctx.core.priceFeed,
        itemIntelligence: ctx.core.itemIntelligence,
        marketTrends: ctx.core.marketTrends,
        watchlist: ctx.core.watchlist,
        settings: () => settings.get(),
        clipboard: ctx.clipboard,
        openExternal: (url) => ctx.openExternal(url),
        capture,
        onSession: (session) => ctx.emit("evaluate:session", session),
        log: (level, message, detail) => ctx.log({ feature: "evaluate", level, message, detail }),
      });

      /** Shows the panel for the session, or a notice when the capture failed. */
      const present = async (
        result: Awaited<ReturnType<EvaluateService["open"]>>,
        showOverlay: boolean,
      ): Promise<void> => {
        if (!showOverlay) return;
        if (isOpenFailure(result)) {
          const payload: NoticePayload = {
            title: "Evaluate",
            body: result.error,
            tone: result.reason === "blocked" || result.reason === "timeout" ? "warning" : "info",
            ttlMs: 6000,
          };
          await overlay.show("notice", { anchor: "top-right", payload });
          return;
        }
        await overlay.show(EVALUATE_PANEL_ID, {
          anchor: "cursor",
          focus: true,
          payload: { sessionId: result.id },
          width: EVALUATE_PANEL_SIZE.width,
          height: EVALUATE_PANEL_SIZE.height,
        });
      };

      ctx.handle("evaluate:open", async (raw: unknown) => {
        const input = openInputFrom(raw);
        const showOverlay = input.showOverlay ?? (input.source === "hotkey" || input.source === "clipboard");
        const result = await service.open(input);
        await present(result, showOverlay);
        return result;
      });
      ctx.handle("evaluate:current", () => service.current());
      ctx.handle("evaluate:search", (sessionId: string, query: EvaluateQueryState) =>
        service.search(String(sessionId ?? ""), query),
      );
      ctx.handle("evaluate:more", (sessionId: string) => service.more(String(sessionId ?? "")));
      ctx.handle("evaluate:exchange", (sessionId: string) => service.exchange(String(sessionId ?? "")));
      ctx.handle("evaluate:set-profile", (sessionId: string, profile: EvaluateProfileId) =>
        service.setProfile(String(sessionId ?? ""), profile),
      );
      ctx.handle("evaluate:copy", (sessionId: string, what: unknown) =>
        service.copy(String(sessionId ?? ""), copyRequestFrom(what)),
      );
      ctx.handle("evaluate:open-site", (sessionId: string) => service.openSite(String(sessionId ?? "")));
      ctx.handle("evaluate:watch", (sessionId: string) => service.watch(String(sessionId ?? "")));
      ctx.handle("evaluate:close", (sessionId: string) => {
        service.close(String(sessionId ?? ""));
        overlay.hide(EVALUATE_PANEL_ID);
      });
      ctx.handle("evaluate:budget", () => service.budget());

      const stopHotkey = hotkeys.contribute({
        id: EVALUATE_HOTKEY_ID,
        label: "Evaluate (price check)",
        detail:
          "Copies the hovered item with one Ctrl+C and opens the Evaluate panel at the cursor. Dry-run reads the clipboard instead; price lookups still run.",
        group: "Overlay",
        defaultAccelerator: "Alt+E",
        run: async () => {
          // open() resolves as soon as the session exists: the panel is on
          // screen (spinner and all) before the auto-search answers.
          const result = await service.open({ source: "hotkey" });
          await present(result, true);
        },
      });
      const stopClipboardHotkey = hotkeys.contribute({
        id: EVALUATE_CLIPBOARD_HOTKEY_ID,
        label: "Evaluate the clipboard item",
        detail:
          "Opens the Evaluate panel for the item text already on the clipboard (Ctrl+D triggers this too). No search is sent until you press Search.",
        group: "Overlay",
        defaultAccelerator: null,
        run: async () => {
          const result = await service.open({ source: "clipboard", autoSearch: false });
          await present(result, true);
        },
      });

      // The user closed the panel: the session stays so the Item log section
      // can still show it; only the busy state is settled.
      const stopPanelEvents = overlay.onPanelEvent((event) => {
        if (event.panelId !== EVALUATE_PANEL_ID) return;
        if (event.kind === "closed-by-user" || event.kind === "hidden") {
          const current = service.current();
          if (current) service.close(current.id);
        }
      });

      return {
        dispose() {
          stopHotkey();
          stopClipboardHotkey();
          stopPanelEvents();
          service.dispose();
        },
      };
    },
  };
}

export const evaluateModule: FeatureModule = createEvaluateModule();
export { DEFAULT_EVALUATE_SETTINGS };
