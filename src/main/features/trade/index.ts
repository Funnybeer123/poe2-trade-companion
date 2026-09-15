/**
 * Feature module "trade": offer cards from the whispers the game already
 * wrote to Client.txt, one chat line per click, and the trades the game
 * confirmed as a 14-day history.
 *
 * Safety shape (docs/GGG_COMPLIANCE.md): every game-touching action is
 * exactly ONE call into the chat command service (Enter, text, Enter — or the
 * stash search hotkey, text, Enter). No chains, no auto-invite, no
 * auto-trade, no timed follow-ups, and no click capability at all: the trade
 * window's Accept is always the user's. Zero trade2 / poe2scout requests —
 * prices come from the price table already in memory. The only outbound
 * traffic is the user's own Discord / Telegram endpoint.
 */
import {
  applyClientLogEvent,
  applyOfferTransition,
  chatLineForAction,
  divineRateSourceOf,
  expireOffers,
  isActive,
  latestActiveOffer,
  offerPlaceholderContext,
  type TradeReduceContext,
  type TradeReduceEffect,
} from "../../../core/tradeOffers.js";
import { priceInExalted } from "../../../core/tradeListings.js";
import { resolvePlaceholders } from "../../../core/chatCommands.js";
import { redactSecrets, redactSecretsDeep } from "../../../core/tradeNotify.js";
import { historyEntryFromOffer } from "../../../core/tradeOffers.js";
import type { ClientLogEvent } from "../../../core/clientLog.js";
import type { PriceTable } from "../../../core/priceTable.js";
import type { TradeHistoryEntry } from "../../../shared/trade.js";
import {
  DEFAULT_TRADE_SETTINGS,
  isTownLike,
  normalizeTradeSettings,
  type TradeActionOrigin,
  type TradeActionOutcome,
  type TradeCsvExportResult,
  type TradeHistoryEdit,
  type TradeOffer,
  type TradeOfferAction,
  type TradePanelPayload,
  type TradeSettings,
  type TradeStatus,
  type TradeWebhookSecretsPatch,
} from "../../../shared/trade.js";
import type { FeatureContext, FeatureModule } from "../types.js";
import { realTradeFs, type TradeFs } from "./fs.js";
import { TradeHistoryStore } from "./historyStore.js";
import { TradeNotifier } from "./notifier.js";
import { TradeOfferStore } from "./offerStore.js";

export const TRADE_SETTINGS_ID = "trade";
export const TRADE_OFFERS_FILE = "trade-offers.json";
export const TRADE_HISTORY_FILE = "trade-history.json";
export const TRADE_WEBHOOKS_SECRET_FILE = "trade-webhooks.secret.json";
/** Under ctx.configDir (artifacts/tab-admin) — READ-ONLY. */
export const SHOP_LEDGER_FILE = "listings.jsonl";
export const TRADE_PANEL_ID = "trade";
export const TRADE_PANEL_SIZE = { width: 380, height: 260 } as const;
export const TRADE_TICK_MS = 60_000;

export interface SaveDialogLike {
  showSaveDialog(options: {
    title?: string;
    defaultPath?: string;
    filters?: Array<{ name: string; extensions: string[] }>;
  }): Promise<{ canceled: boolean; filePath?: string }>;
}

export interface TradeModuleDeps {
  fetchImpl?: typeof fetch;
  now?: () => Date;
  timers?: { setInterval(cb: () => void, ms: number): unknown; clearInterval(handle: unknown): void };
  fs?: TradeFs;
  dialog?: SaveDialogLike;
  /** Skips the 60 s interval; the test drives `tick()` itself. */
  manualTicks?: boolean;
  rand?: () => string;
  documentsDir?: string;
}

function join(dir: string, file: string): string {
  return `${dir.replace(/[\\/]+$/, "")}/${file}`;
}

export function createTradeModule(deps: TradeModuleDeps = {}): FeatureModule {
  return {
    id: "trade",
    register(ctx: FeatureContext) {
      const nowDate = deps.now ?? (() => new Date());
      const nowIso = () => nowDate().toISOString();
      const fs = deps.fs ?? realTradeFs;

      const log = (level: "info" | "warn" | "error", message: string, detail?: unknown): void => {
        // Offers and history rows carry other players' names and whisper text:
        // only ids and counts ever reach a log, and every string is redacted.
        ctx.log({
          feature: "trade",
          level,
          message: redactSecrets(message),
          detail: detail === undefined ? undefined : redactSecretsDeep(detail),
        });
      };

      const settingsNamespace = ctx.settings.namespace<TradeSettings>(TRADE_SETTINGS_ID, (raw) => {
        const { value, issues } = normalizeTradeSettings(raw);
        if (issues.length > 0) log("warn", "settings sanitized", issues);
        return value;
      });
      const settings = (): TradeSettings => settingsNamespace.get() ?? DEFAULT_TRADE_SETTINGS;

      const clientLog = ctx.require("clientLog");
      const chat = ctx.require("chatCommands");
      const overlay = ctx.require("overlay");
      const hotkeys = ctx.require("hotkeys");

      const priceTable = (): PriceTable | undefined => {
        try {
          return ctx.core.itemIntelligence.getPriceTable();
        } catch {
          return undefined;
        }
      };

      const offerStore = new TradeOfferStore({
        file: join(ctx.userDataDir, TRADE_OFFERS_FILE),
        now: nowIso,
        settings,
        fs,
        log,
      });
      const historyStore = new TradeHistoryStore({
        file: join(ctx.userDataDir, TRADE_HISTORY_FILE),
        shopLedgerFile: join(ctx.configDir, SHOP_LEDGER_FILE),
        now: nowIso,
        settings,
        priceTable,
        fs,
        log,
        rand: deps.rand,
      });
      const notifier = new TradeNotifier({
        secretFile: join(ctx.userDataDir, TRADE_WEBHOOKS_SECRET_FILE),
        settings,
        notify: (title, body) => ctx.notify(title, body),
        toast: (payload) => overlay.show("notice", { anchor: "top-right", payload }),
        fetchImpl: deps.fetchImpl,
        now: () => nowDate().getTime(),
        fs,
        log,
        onStatus: (status) => ctx.emit("trade:webhooks", status),
      });

      let poeRunning = false;
      let panelFocused = false;
      let explicitlyShown = false;
      let lastPruneDay = "";

      // ---------------------------------------------------------------------
      // Status and panel payload
      // ---------------------------------------------------------------------

      function reduceContext(): TradeReduceContext {
        const logStatus = clientLog.status();
        const context: TradeReduceContext = {
          now: nowIso(),
          settings: settings(),
          priceTable: priceTable(),
          inTown: isTownLike(logStatus.area?.info.category),
        };
        const league = feedLeague();
        if (league) context.resolvedLeague = league;
        if (logStatus.character?.name) context.character = logStatus.character.name;
        return context;
      }

      function feedLeague(): string | undefined {
        try {
          return ctx.core.priceFeed.status().resolvedLeague;
        } catch {
          return undefined;
        }
      }

      function feedAgeHours(): number | undefined {
        try {
          return ctx.core.priceFeed.status().feedAgeHours;
        } catch {
          return undefined;
        }
      }

      function status(): TradeStatus {
        const logStatus = clientLog.status();
        const table = priceTable();
        const overlayState = overlay.state();
        const value: TradeStatus = {
          enabled: settings().enabled,
          clientLog: { watching: logStatus.watching },
          divineRate: priceInExalted(1, "divine", table) ?? 0,
          divineRateSource: divineRateSourceOf(table),
          activeOffers: offerStore.active().length,
          dryRun: ctx.dryRun(),
          poeRunning,
          panelVisible: overlayState.visiblePanels.includes(TRADE_PANEL_ID),
          panelPinned: overlayState.pinnedPanels.includes(TRADE_PANEL_ID),
          panelFocused,
        };
        if (logStatus.file) value.clientLog.file = logStatus.file;
        if (logStatus.error) value.clientLog.error = logStatus.error;
        if (logStatus.area) {
          value.area = {
            id: logStatus.area.areaId,
            name: logStatus.area.info.name,
            category: logStatus.area.info.category,
            inTown: isTownLike(logStatus.area.info.category),
          };
        }
        if (logStatus.character?.name) value.character = logStatus.character.name;
        const league = feedLeague();
        if (league) value.league = league;
        const age = feedAgeHours();
        if (age !== undefined) value.feedAgeHours = age;
        try {
          value.chat = chat.status();
        } catch {
          // The chat service is optional for reading offers.
        }
        const storeError = offerStore.lastError ?? historyStore.lastError;
        if (storeError) value.lastError = storeError;
        return value;
      }

      function emitStatus(): void {
        ctx.emit("trade:status", status());
      }

      function panelPayload(): TradePanelPayload {
        const current = settings();
        return {
          offers: offerStore.list(),
          status: status(),
          settings: {
            compact: current.compact,
            autoExpandInTown: current.autoExpandInTown,
            invertedOrder: current.invertedOrder,
            quickWhispers: current.quickWhispers,
          },
        };
      }

      async function showPanel(explicit: boolean): Promise<void> {
        if (explicit) explicitlyShown = true;
        // A second show() would re-resolve the anchor and yank a dragged panel
        // back: update the payload instead when it is already open.
        if (overlay.isVisible(TRADE_PANEL_ID)) {
          overlay.update(TRADE_PANEL_ID, panelPayload());
          return;
        }
        await overlay.show(TRADE_PANEL_ID, {
          anchor: settings().panelAnchor,
          payload: panelPayload(),
          width: TRADE_PANEL_SIZE.width,
          height: TRADE_PANEL_SIZE.height,
        });
      }

      function hidePanel(): void {
        overlay.hide(TRADE_PANEL_ID);
        explicitlyShown = false;
        panelFocused = false;
      }

      function refreshPanel(): void {
        if (!overlay.isVisible(TRADE_PANEL_ID)) return;
        overlay.update(TRADE_PANEL_ID, panelPayload());
      }

      function maybeHideIdle(): void {
        if (offerStore.active().length > 0) return;
        if (!settings().hidePanelWhenIdle || explicitlyShown) return;
        if (!overlay.isVisible(TRADE_PANEL_ID)) return;
        if (overlay.state().pinnedPanels.includes(TRADE_PANEL_ID)) return;
        overlay.hide(TRADE_PANEL_ID);
        panelFocused = false;
      }

      function emitChanged(): void {
        ctx.emit("trade:changed", offerStore.list());
        refreshPanel();
      }

      // ---------------------------------------------------------------------
      // Effects
      // ---------------------------------------------------------------------

      async function refreshPoeRunning(): Promise<boolean> {
        try {
          poeRunning = (await ctx.poeWindows()).length > 0;
        } catch {
          poeRunning = false;
        }
        return poeRunning;
      }

      function addHistory(entry: TradeHistoryEntry): void {
        try {
          const view = historyStore.add(entry);
          ctx.emit("trade:history-changed", view);
        } catch (error) {
          log("warn", "history entry could not be recorded", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      async function announceNew(offer: TradeOffer): Promise<void> {
        const current = settings();
        if (offer.direction === "outgoing" && !current.notifications.outgoing) return;
        const running = await refreshPoeRunning();
        const shouldShow =
          running &&
          (current.showPanelOnOffer === "always" ||
            (current.showPanelOnOffer === "town" && isTownLike(clientLog.status().area?.info.category)));
        let panelShown = false;
        if (shouldShow) {
          await showPanel(false);
          panelShown = true;
        }
        const fired = await notifier.announce(offer, { panelShown });
        const stored = offerStore.get(offer.id);
        if (stored) {
          const updated: TradeOffer = { ...stored, notified: { ...stored.notified, ...fired } };
          offerStore.replace(offerStore.raw().map((row) => (row.id === updated.id ? updated : row)));
        }
        const payload: { offer: TradeOffer; reason: "new"; playSoundIn?: "overlay" | "main" } = {
          offer: offerStore.get(offer.id) ?? offer,
          reason: "new",
        };
        if (fired.sound) payload.playSoundIn = panelShown ? "overlay" : "main";
        ctx.emit("trade:offer", payload);
      }

      async function applyEffects(effects: readonly TradeReduceEffect[]): Promise<void> {
        if (effects.length === 0) return;
        emitChanged();
        for (const effect of effects) {
          switch (effect.kind) {
            case "offer-new":
              await announceNew(effect.offer);
              break;
            case "offer-repeat":
              ctx.emit("trade:offer", { offer: effect.offer, reason: "repeat" });
              break;
            case "offer-message":
              ctx.emit("trade:offer", { offer: effect.offer, reason: "message" });
              break;
            case "offer-state":
            case "offer-timeout":
              ctx.emit("trade:offer", { offer: effect.offer, reason: "state" });
              break;
            case "history-add":
              addHistory(effect.entry);
              break;
          }
        }
        maybeHideIdle();
        emitStatus();
      }

      async function handleLogEvent(event: ClientLogEvent): Promise<void> {
        try {
          const result = applyClientLogEvent(offerStore.raw(), event, reduceContext(), deps.rand);
          if (result.effects.length === 0) {
            if (event.kind === "area") emitStatus();
            return;
          }
          offerStore.replace(result.offers);
          await applyEffects(result.effects);
        } catch (error) {
          log("error", "client log event could not be applied", {
            kind: event.kind,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      const stopListeners = [
        clientLog.on("whisper", (event) => void handleLogEvent(event)),
        clientLog.on("area-join", (event) => void handleLogEvent(event)),
        clientLog.on("party", (event) => void handleLogEvent(event)),
        clientLog.on("trade", (event) => void handleLogEvent(event)),
        clientLog.on("area", () => {
          refreshPanel();
          emitStatus();
        }),
        overlay.onPanelEvent((event) => {
          if (event.panelId !== TRADE_PANEL_ID) return;
          if (event.kind === "closed-by-user" || event.kind === "hidden") {
            explicitlyShown = false;
            panelFocused = false;
            emitStatus();
          }
        }),
        settingsNamespace.onChange(() => {
          refreshPanel();
          emitStatus();
        }),
      ];

      // ---------------------------------------------------------------------
      // Actions
      // ---------------------------------------------------------------------

      function quickWhisperText(offer: TradeOffer, id: string): string | undefined {
        const template = settings().quickWhispers.find((entry) => entry.id === id);
        if (!template) return undefined;
        const extra: { char?: string; area?: string } = {};
        const logStatus = clientLog.status();
        if (logStatus.character?.name) extra.char = logStatus.character.name;
        if (logStatus.area?.info.name) extra.area = logStatus.area.info.name;
        return resolvePlaceholders(template.template, offerPlaceholderContext(offer, extra));
      }

      async function runAction(
        offerId: string,
        action: TradeOfferAction,
        origin: TradeActionOrigin,
      ): Promise<TradeActionOutcome> {
        const offer = offerStore.get(offerId);
        if (!offer) return { ok: false, error: "That offer is no longer listed" };
        const now = nowIso();

        if (action.kind === "dismiss" || action.kind === "complete" || action.kind === "reopen") {
          const next =
            action.kind === "dismiss" ? "dismissed" : action.kind === "complete" ? "completed" : "new";
          const result = applyOfferTransition(offerStore.raw(), offerId, next, "user", now);
          offerStore.replace(result.offers);
          const updated = offerStore.get(offerId);
          if (action.kind === "complete" && updated) {
            const entry = historyEntryFromOffer(updated, now, deps.rand);
            offerStore.replace(
              offerStore.raw().map((row) => (row.id === offerId ? { ...row, historyId: entry.id } : row)),
            );
            addHistory(entry);
          }
          await applyEffects(result.effects);
          return { ok: true, offer: offerStore.get(offerId) ?? offer };
        }

        if (action.kind === "copy-whisper") {
          const text =
            action.text?.trim() ||
            (action.id ? quickWhisperText(offer, action.id) : undefined) ||
            `@${offer.player} `;
          ctx.clipboard.writeText(text);
          return { ok: true, offer, copied: text };
        }

        const extra: { char?: string; area?: string } = {};
        const logStatus = clientLog.status();
        if (logStatus.character?.name) extra.char = logStatus.character.name;
        if (logStatus.area?.info.name) extra.area = logStatus.area.info.name;
        const line = chatLineForAction(offer, action, settings(), extra);
        if ("error" in line) return { ok: false, offer, error: line.error };

        // Focus hand-off (§7.6 step 0): the desktop window and the focused
        // overlay panel are BOTH "not the game", so the game must be brought
        // forward first; a hotkey or an unfocused panel means the game already
        // has focus and no window switch is needed.
        let focus = origin === "desktop";
        if (origin === "overlay" && panelFocused) {
          overlay.setFocus(TRADE_PANEL_ID, false);
          panelFocused = false;
          emitStatus();
          focus = true;
        }

        const outcome = line.stashSearch
          ? await chat.stashSearch(line.text, line.reason, { focus })
          : await chat.send({ text: line.text, reason: line.reason, source: "trade", focus });

        if (outcome.ok && !outcome.dryRun && line.nextState && line.via) {
          const result = applyOfferTransition(
            offerStore.raw(),
            offerId,
            line.nextState,
            line.via,
            nowIso(),
            line.detail,
          );
          offerStore.replace(result.offers);
          await applyEffects(result.effects);
        }
        return { ok: outcome.ok, offer: offerStore.get(offerId) ?? offer, chat: outcome };
      }

      function normalizeOrigin(value: unknown): TradeActionOrigin {
        return value === "overlay" || value === "hotkey" ? value : "desktop";
      }

      function normalizeAction(value: unknown): TradeOfferAction {
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
          throw new Error("trade-action-invalid");
        }
        const kind = (value as { kind?: unknown }).kind;
        const known = [
          "invite",
          "trade",
          "kick",
          "hideout",
          "leave",
          "highlight",
          "quick-whisper",
          "custom-whisper",
          "copy-whisper",
          "dismiss",
          "complete",
          "reopen",
        ];
        if (typeof kind !== "string" || !known.includes(kind)) throw new Error("trade-action-invalid");
        return value as TradeOfferAction;
      }

      // ---------------------------------------------------------------------
      // Channels
      // ---------------------------------------------------------------------

      ctx.handle("trade:offers", () => offerStore.list());

      ctx.handle(
        "trade:offer-action",
        async (offerId: string, action: unknown, origin?: unknown): Promise<TradeActionOutcome> => {
          const id = String(offerId ?? "").trim();
          if (!id) throw new Error("trade-offer-id-required");
          return runAction(id, normalizeAction(action), normalizeOrigin(origin));
        },
      );

      ctx.handle("trade:dismiss-all", async () => {
        const now = nowIso();
        let offers = offerStore.raw();
        const effects: TradeReduceEffect[] = [];
        for (const offer of offers.filter(isActive)) {
          const result = applyOfferTransition(offers, offer.id, "dismissed", "user", now);
          offers = result.offers;
          effects.push(...result.effects);
        }
        offerStore.replace(offers);
        await applyEffects(effects);
        return offerStore.list();
      });

      ctx.handle("trade:status", () => status());

      ctx.handle("trade:panel", async (action: unknown) => {
        const mode = action === "hide" ? "hide" : action === "toggle" ? "toggle" : "show";
        if (mode === "hide") hidePanel();
        else if (mode === "show") await showPanel(true);
        else if (overlay.isVisible(TRADE_PANEL_ID)) hidePanel();
        else await showPanel(true);
        const next = status();
        ctx.emit("trade:status", next);
        return next;
      });

      ctx.handle("trade:panel-focus", (focus: unknown) => {
        const wanted = Boolean(focus);
        overlay.setFocus(TRADE_PANEL_ID, wanted);
        panelFocused = wanted;
        const next = status();
        ctx.emit("trade:status", next);
        return next;
      });

      ctx.handle("trade:history", () => historyStore.view());

      ctx.handle("trade:history-save", (edit: unknown) => {
        if (typeof edit !== "object" || edit === null || Array.isArray(edit)) {
          throw new Error("trade-history-edit-object-required");
        }
        const view = historyStore.save(edit as TradeHistoryEdit);
        ctx.emit("trade:history-changed", view);
        return view;
      });

      ctx.handle("trade:history-delete", (id: unknown) => {
        const entryId = String(id ?? "").trim();
        if (!entryId) throw new Error("trade-history-id-required");
        const view = historyStore.remove(entryId);
        ctx.emit("trade:history-changed", view);
        return view;
      });

      ctx.handle("trade:history-export", async (target: unknown): Promise<TradeCsvExportResult> => {
        if (target !== "file" && target !== "clipboard") throw new Error("trade-export-target-invalid");
        const rows = historyStore.count();
        if (rows === 0) return { ok: false, rows: 0, reason: "empty" };
        const csv = historyStore.csv();
        if (target === "clipboard") {
          ctx.clipboard.writeText(csv);
          return { ok: true, rows, copied: true };
        }
        // Electron is imported lazily: a top-level import would break every
        // vitest run of this module (Electron-as-Node has no module surface).
        let dialog = deps.dialog;
        let documents = deps.documentsDir;
        if (!dialog || !documents) {
          try {
            const electron = await import("electron");
            dialog = dialog ?? (electron.dialog as unknown as SaveDialogLike);
            documents = documents ?? electron.app.getPath("documents");
          } catch {
            documents = documents ?? ctx.userDataDir;
          }
        }
        if (!dialog) return { ok: false, rows, reason: "write-failed", error: "no save dialog available" };
        const day = nowIso().slice(0, 10);
        const answer = await dialog.showSaveDialog({
          title: "Export trade history (includes player names)",
          defaultPath: join(documents ?? ctx.userDataDir, `poe2-trade-history-${day}.csv`),
          filters: [{ name: "CSV", extensions: ["csv"] }],
        });
        if (answer.canceled || !answer.filePath) return { ok: false, rows, reason: "canceled" };
        try {
          fs.write(answer.filePath, csv);
          return { ok: true, rows, path: answer.filePath };
        } catch (error) {
          return {
            ok: false,
            rows,
            reason: "write-failed",
            error: error instanceof Error ? error.message : String(error),
          };
        }
      });

      ctx.handle("trade:webhooks", () => notifier.status());

      ctx.handle("trade:webhooks-set", (patch: unknown) => {
        if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
          throw new Error("trade-webhooks-object-required");
        }
        const status_ = notifier.setSecrets(patch as TradeWebhookSecretsPatch);
        ctx.emit("trade:webhooks", status_);
        return status_;
      });

      ctx.handle("trade:webhooks-test", async (target: unknown) => {
        if (target !== "discord" && target !== "telegram") throw new Error("trade-webhooks-target-invalid");
        return notifier.test(target);
      });

      // ---------------------------------------------------------------------
      // Hotkeys
      // ---------------------------------------------------------------------

      async function runLatest(
        states: readonly TradeOffer["state"][],
        action: TradeOfferAction,
        emptyMessage: string,
      ): Promise<void> {
        const offer = latestActiveOffer(offerStore.raw(), "incoming", states);
        if (!offer) {
          await overlay.show("notice", {
            anchor: "top-right",
            payload: { title: "Trade", body: emptyMessage, tone: "warning", ttlMs: 4_000 },
          });
          return;
        }
        await runAction(offer.id, action, "hotkey");
      }

      const stopHotkeys = [
        hotkeys.contribute({
          id: "trade.panel",
          label: "Trade panel",
          detail: "Show or hide the in-game offer panel.",
          group: "Trade",
          defaultAccelerator: "Alt+T",
          run: async () => {
            if (overlay.isVisible(TRADE_PANEL_ID)) hidePanel();
            else await showPanel(true);
            emitStatus();
          },
        }),
        hotkeys.contribute({
          id: "trade.invite-latest",
          label: "Invite newest buyer",
          detail: "Types /invite <player> for the newest buyer who has not been invited yet.",
          group: "Trade",
          defaultAccelerator: null,
          run: () => runLatest(["new"], { kind: "invite" }, "No new buyer to invite"),
        }),
        hotkeys.contribute({
          id: "trade.trade-latest",
          label: "Trade with newest buyer",
          detail: "Types /tradewith <player> for the newest buyer who joined or was invited.",
          group: "Trade",
          defaultAccelerator: null,
          run: () => runLatest(["joined", "invited"], { kind: "trade" }, "No buyer ready to trade with"),
        }),
      ];

      // ---------------------------------------------------------------------
      // Tick: timeouts, PoE detection, the daily prune
      // ---------------------------------------------------------------------

      /**
       * Never rejects: the interval discards the promise, so a throw from a
       * destroyed overlay window or a renderer listener would surface as an
       * unhandled rejection in the main process (fatal under
       * `--unhandled-rejections=strict`). Same guard as `handleLogEvent`.
       */
      async function tick(): Promise<void> {
        try {
          const before = poeRunning;
          await refreshPoeRunning();
          const result = expireOffers(offerStore.raw(), reduceContext());
          if (result.effects.length > 0 || result.offers.length !== offerStore.raw().length) {
            offerStore.replace(result.offers);
            await applyEffects(result.effects);
          }
          const day = nowIso().slice(0, 10);
          if (day !== lastPruneDay) {
            lastPruneDay = day;
            const pruned = historyStore.prune();
            if (pruned > 0) ctx.emit("trade:history-changed", historyStore.view());
          }
          if (before !== poeRunning) emitStatus();
        } catch (error) {
          log("error", "trade tick failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      const timers = deps.timers ?? {
        setInterval: (cb: () => void, ms: number) => {
          const handle = setInterval(cb, ms);
          handle.unref?.();
          return handle;
        },
        clearInterval: (handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>),
      };
      const tickHandle = deps.manualTicks ? undefined : timers.setInterval(() => void tick(), TRADE_TICK_MS);
      lastPruneDay = nowIso().slice(0, 10);
      void refreshPoeRunning();

      const handle = {
        /** Exposed for tests that drive the clock themselves. */
        tick,
        dispose: () => {
          for (const stop of [...stopListeners, ...stopHotkeys]) {
            try {
              stop();
            } catch {
              // A listener that is already gone must not block disposal.
            }
          }
          if (tickHandle !== undefined) timers.clearInterval(tickHandle);
          offerStore.dispose();
          historyStore.flush();
          notifier.dispose();
        },
      };
      return handle;
    },
  };
}

export const tradeModule: FeatureModule = createTradeModule();
