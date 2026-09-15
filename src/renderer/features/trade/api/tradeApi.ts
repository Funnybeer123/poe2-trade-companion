/**
 * Renderer client for the "trade" package. Returns null in the browser
 * preview so every surface renders its "desktop app only" state instead of
 * invoking a bridge that is not there.
 */
import type { TradeContract, TradeEvents } from "../../../../shared/trade";
import { createFeatureApi, type FeatureApi } from "../../../services/featureApi";

export type TradeApi = FeatureApi<TradeContract, TradeEvents>;

export function getTradeApi(): TradeApi | null {
  return createFeatureApi<TradeContract, TradeEvents>();
}

export type {
  TradeActionOrigin,
  TradeActionOutcome,
  TradeCsvExportResult,
  TradeHistoryEdit,
  TradeHistoryEntry,
  TradeHistoryView,
  TradeOffer,
  TradeOfferAction,
  TradePanelPayload,
  TradeQuickWhisper,
  TradeSettings,
  TradeStatus,
  TradeWebhookStatus,
} from "../../../../shared/trade";
