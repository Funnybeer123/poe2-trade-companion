/**
 * One module-level store shared by the Trade view, the settings cards and the
 * overlay panel: main is the single source of truth, the renderer only mirrors
 * what `trade:*` events push.
 *
 * Every mutation goes through `runAction` / `save*` so exactly one request is
 * in flight per gesture and the last outcome ("Typed /invite …", "Dry-run:
 * would type …", "Blocked: …") is visible somewhere.
 */
import { ref, type Ref } from "vue";
import { createFeatureApi, getAppFeatureApi } from "../../../services/featureApi";
import type { ChatContract, ChatEvents } from "../../../../shared/chatCommands";
import { getTradeApi, type TradeApi } from "./tradeApi";
import { describeChatOutcome } from "./formatTrade";
import { isOverlayWindow, playOfferSound } from "./useTradeSound";
import {
  DEFAULT_TRADE_SETTINGS,
  type TradeActionOrigin,
  type TradeCsvExportResult,
  type TradeHistoryEdit,
  type TradeHistoryView,
  type TradeOffer,
  type TradeOfferAction,
  type TradeSettings,
  type TradeStatus,
  type TradeWebhookSecretsPatch,
  type TradeWebhookStatus,
} from "../../../../shared/trade";

const offers = ref<TradeOffer[]>([]);
const status = ref<TradeStatus | null>(null);
const history = ref<TradeHistoryView | null>(null);
const settings = ref<TradeSettings>({ ...DEFAULT_TRADE_SETTINGS });
const webhooks = ref<TradeWebhookStatus | null>(null);
const loading = ref(true);
const error = ref("");
const notice = ref("");
const busyOfferId = ref("");
const busy = ref(false);

let subscribers = 0;
let unsubscribers: Array<() => void> = [];

function describeError(reason: unknown, fallback: string): string {
  return reason instanceof Error && reason.message ? reason.message : fallback;
}

async function loadSettings(): Promise<void> {
  const app = getAppFeatureApi();
  if (!app) return;
  try {
    const snapshot = await app.invoke("settings:get");
    const value = snapshot["trade"];
    if (value && typeof value === "object") settings.value = value as TradeSettings;
  } catch {
    // The feature still works with the defaults; the view shows its own error.
  }
}

async function refresh(api: TradeApi): Promise<void> {
  const [nextOffers, nextStatus] = await Promise.all([
    api.invoke("trade:offers"),
    api.invoke("trade:status"),
  ]);
  offers.value = nextOffers;
  status.value = nextStatus;
}

export interface TradeStore {
  offers: Ref<TradeOffer[]>;
  status: Ref<TradeStatus | null>;
  history: Ref<TradeHistoryView | null>;
  settings: Ref<TradeSettings>;
  webhooks: Ref<TradeWebhookStatus | null>;
  loading: Ref<boolean>;
  error: Ref<string>;
  notice: Ref<string>;
  busy: Ref<boolean>;
  busyOfferId: Ref<string>;
  available: boolean;
  initializeTradeStore(): Promise<void>;
  disposeTradeStore(): void;
  reload(): Promise<void>;
  runAction(offerId: string, action: TradeOfferAction, origin?: TradeActionOrigin): Promise<void>;
  dismissAll(): Promise<void>;
  togglePanel(action?: "show" | "hide" | "toggle"): Promise<void>;
  setPanelFocus(focus: boolean): Promise<void>;
  saveSettings(patch: Partial<TradeSettings>): Promise<void>;
  loadHistory(): Promise<void>;
  saveHistory(edit: TradeHistoryEdit): Promise<void>;
  deleteHistory(id: string): Promise<void>;
  exportHistory(target: "file" | "clipboard"): Promise<TradeCsvExportResult | undefined>;
  loadWebhooks(): Promise<void>;
  saveWebhooks(patch: TradeWebhookSecretsPatch): Promise<void>;
  testWebhook(target: "discord" | "telegram"): Promise<void>;
}

export function useTradeStore(): TradeStore {
  const api = getTradeApi();

  async function initializeTradeStore(): Promise<void> {
    subscribers += 1;
    if (!api) {
      loading.value = false;
      return;
    }
    if (subscribers === 1) {
      unsubscribers = [
        api.on("trade:changed", (next) => {
          offers.value = next;
        }),
        api.on("trade:status", (next) => {
          status.value = next;
        }),
        api.on("trade:history-changed", (next) => {
          history.value = next;
        }),
        api.on("trade:webhooks", (next) => {
          webhooks.value = next;
        }),
        api.on("trade:offer", (event) => {
          if (event.reason !== "new" || !event.playSoundIn) return;
          if (event.playSoundIn === (isOverlayWindow() ? "overlay" : "main")) playOfferSound();
        }),
      ];
      // The chat service owns "enabled", the kill switch and the per-minute
      // budget, and it announces them on its OWN event. Without this the
      // readiness row and every action button keep the state they had when the
      // view opened — the user would press Invite on a button the UI claims is
      // live and get "Blocked: chat commands are disabled".
      const chatApi = createFeatureApi<ChatContract, ChatEvents>();
      if (chatApi) {
        unsubscribers.push(
          chatApi.on("chat:status", () => {
            if (!api) return;
            void api.invoke("trade:status").then(
              (next) => {
                status.value = next;
              },
              () => undefined,
            );
          }),
        );
      }
      const app = getAppFeatureApi();
      if (app) {
        unsubscribers.push(
          app.on("settings:changed", (event) => {
            if (event.id === "trade" && event.value && typeof event.value === "object") {
              settings.value = event.value as TradeSettings;
            }
          }),
        );
      }
    }
    try {
      await Promise.all([refresh(api), loadSettings()]);
    } catch (reason) {
      error.value = describeError(reason, "Trade could not be loaded.");
    } finally {
      loading.value = false;
    }
  }

  function disposeTradeStore(): void {
    subscribers = Math.max(0, subscribers - 1);
    if (subscribers > 0) return;
    for (const stop of unsubscribers) {
      try {
        stop();
      } catch {
        // Already gone.
      }
    }
    unsubscribers = [];
  }

  async function guard(action: () => Promise<void>, fallback: string): Promise<void> {
    if (!api || busy.value) return;
    busy.value = true;
    error.value = "";
    try {
      await action();
    } catch (reason) {
      error.value = describeError(reason, fallback);
    } finally {
      busy.value = false;
      busyOfferId.value = "";
    }
  }

  return {
    offers,
    status,
    history,
    settings,
    webhooks,
    loading,
    error,
    notice,
    busy,
    busyOfferId,
    available: Boolean(api),
    initializeTradeStore,
    disposeTradeStore,
    reload: () =>
      guard(async () => {
        if (api) await refresh(api);
      }, "Trade could not be loaded."),
    runAction: (offerId, action, origin = "desktop") =>
      guard(async () => {
        if (!api) return;
        busyOfferId.value = offerId;
        const outcome = await api.invoke("trade:offer-action", offerId, action, origin);
        if (outcome.copied) notice.value = `Copied: ${outcome.copied}`;
        else if (outcome.chat) notice.value = describeChatOutcome(outcome.chat);
        else if (outcome.error) notice.value = outcome.error;
        else notice.value = "";
        if (!outcome.ok && outcome.error) error.value = outcome.error;
        offers.value = await api.invoke("trade:offers");
      }, "That action could not be run."),
    dismissAll: () =>
      guard(async () => {
        if (!api) return;
        offers.value = await api.invoke("trade:dismiss-all");
        notice.value = "Dismissed every active offer.";
      }, "The offers could not be dismissed."),
    togglePanel: (action = "toggle") =>
      guard(async () => {
        if (!api) return;
        status.value = await api.invoke("trade:panel", action);
      }, "The in-game panel could not be toggled."),
    setPanelFocus: (focus) =>
      guard(async () => {
        if (!api) return;
        status.value = await api.invoke("trade:panel-focus", focus);
      }, "The panel could not take keyboard focus."),
    saveSettings: (patch) =>
      guard(async () => {
        const app = getAppFeatureApi();
        if (!app) return;
        const saved = await app.invoke("settings:set", "trade", patch);
        if (saved && typeof saved === "object") settings.value = saved as TradeSettings;
        notice.value = "Trade settings saved.";
      }, "The settings could not be saved."),
    loadHistory: () =>
      guard(async () => {
        if (!api) return;
        history.value = await api.invoke("trade:history");
      }, "The trade history could not be loaded."),
    saveHistory: (edit) =>
      guard(async () => {
        if (!api) return;
        history.value = await api.invoke("trade:history-save", edit);
        notice.value = "Trade recorded.";
      }, "That trade could not be saved."),
    deleteHistory: (id) =>
      guard(async () => {
        if (!api) return;
        history.value = await api.invoke("trade:history-delete", id);
        notice.value = "Trade removed.";
      }, "That trade could not be removed."),
    exportHistory: async (target) => {
      if (!api) return undefined;
      let result: TradeCsvExportResult | undefined;
      await guard(async () => {
        result = await api.invoke("trade:history-export", target);
        if (result.ok && target === "clipboard") notice.value = `Copied ${result.rows} rows as CSV.`;
        else if (result.ok) notice.value = `Exported ${result.rows} rows to ${result.path}.`;
        else if (result.reason === "empty") notice.value = "There is nothing to export yet.";
        else if (result.reason === "canceled") notice.value = "Export cancelled.";
        else error.value = result.error ?? "The CSV could not be written.";
      }, "The CSV could not be exported.");
      return result;
    },
    loadWebhooks: () =>
      guard(async () => {
        if (!api) return;
        webhooks.value = await api.invoke("trade:webhooks");
      }, "The webhook status could not be read."),
    saveWebhooks: (patch) =>
      guard(async () => {
        if (!api) return;
        webhooks.value = await api.invoke("trade:webhooks-set", patch);
        notice.value = "Webhook settings saved.";
      }, "The webhooks could not be saved."),
    testWebhook: (target) =>
      guard(async () => {
        if (!api) return;
        const result = await api.invoke("trade:webhooks-test", target);
        notice.value = result.lastOk
          ? `${target === "discord" ? "Discord" : "Telegram"} accepted the test message.`
          : `${target === "discord" ? "Discord" : "Telegram"}: ${result.lastError ?? "no answer"}`;
        webhooks.value = await api.invoke("trade:webhooks");
      }, "The test message could not be sent."),
  };
}
