/**
 * The active offer cards, in memory and mirrored to
 * `%APPDATA%/poe2-trade-companion/trade-offers.json`.
 *
 * Memory first, disk after a short debounce: a whisper burst must never block
 * the event path, and a failed write degrades to `lastError` instead of
 * throwing into the client-log listener. The file holds other players' names
 * and the raw whisper text — the same text the game already wrote to
 * Client.txt — so it lives under the user's private app data and is never
 * copied into a log.
 */
import {
  parseOffersFile,
  serializeOffersFile,
  sortOffers,
  isActive,
} from "../../../core/tradeOffers.js";
import type { TradeOffer, TradeSettings } from "../../../shared/trade.js";
import { realTradeFs, type TradeFs } from "./fs.js";

export interface TradeOfferStoreOptions {
  file: string;
  now: () => string;
  settings: () => TradeSettings;
  fs?: TradeFs;
  log?: (level: "info" | "warn" | "error", message: string, detail?: unknown) => void;
  debounceMs?: number;
}

export class TradeOfferStore {
  private readonly fs: TradeFs;
  private readonly debounceMs: number;
  private offers: TradeOffer[];
  private timer: ReturnType<typeof setTimeout> | undefined;
  lastError: string | undefined;

  constructor(private readonly options: TradeOfferStoreOptions) {
    this.fs = options.fs ?? realTradeFs;
    this.debounceMs = options.debounceMs ?? 250;
    let text: string | undefined;
    try {
      text = this.fs.read(options.file);
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
    }
    this.offers = parseOffersFile(text, options.now(), options.settings());
  }

  list(): TradeOffer[] {
    return sortOffers(this.offers, this.options.settings().invertedOrder);
  }

  /** Unsorted snapshot for the reducer (order is the caller's concern). */
  raw(): TradeOffer[] {
    return [...this.offers];
  }

  active(): TradeOffer[] {
    return this.list().filter(isActive);
  }

  get(id: string): TradeOffer | undefined {
    return this.offers.find((offer) => offer.id === id);
  }

  replace(offers: readonly TradeOffer[]): void {
    this.offers = [...offers];
    this.schedule();
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.persist();
    }, this.debounceMs);
    this.timer.unref?.();
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.persist();
  }

  private persist(): void {
    try {
      this.fs.write(this.options.file, serializeOffersFile(this.offers, this.options.now()));
      this.lastError = undefined;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.options.log?.("warn", "trade offers could not be saved", { error: this.lastError });
    }
  }

  dispose(): void {
    this.flush();
  }
}
