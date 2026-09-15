/**
 * The 14-day trade history: `trade-history.json` under the user's app data,
 * plus the app's own verified shop sales merged in from
 * `artifacts/tab-admin/listings.jsonl` (read-only — nothing under artifacts/
 * is ever written or pruned here).
 *
 * The file shape is a contract: the session/home package reads
 * `entries[].at`, `entries[].kind` and `entries[].price.exalted` read-only, so
 * those names are frozen. Totals are NOT stored; they are recomputed per view
 * at the current divine rate because every exalted figure is an estimate.
 */
import { parseListingEvents } from "../../../core/shopListings.js";
import {
  MAX_IGNORED_IDS,
  applyHistoryEdit,
  historyToCsv,
  historyTotals,
  mergeShopLedger,
  parseHistoryFile,
  pruneHistory,
  serializeHistoryFile,
  shopLedgerEntries,
  sortHistory,
} from "../../../core/tradeHistory.js";
import type { PriceTable } from "../../../core/priceTable.js";
import type {
  TradeHistoryEdit,
  TradeHistoryEntry,
  TradeHistoryView,
  TradeSettings,
} from "../../../shared/trade.js";
import { realTradeFs, type TradeFs } from "./fs.js";

export interface TradeHistoryStoreOptions {
  file: string;
  shopLedgerFile: string;
  now: () => string;
  settings: () => Pick<TradeSettings, "historyRetentionDays" | "importShopSales">;
  priceTable: () => PriceTable | undefined;
  fs?: TradeFs;
  log?: (level: "info" | "warn" | "error", message: string, detail?: unknown) => void;
  rand?: () => string;
}

export class TradeHistoryStore {
  private readonly fs: TradeFs;
  private entries: TradeHistoryEntry[] = [];
  private ignoredIds = new Set<string>();
  private ledgerStamp: string | undefined;
  private ledgerError: string | undefined;
  lastError: string | undefined;

  constructor(private readonly options: TradeHistoryStoreOptions) {
    this.fs = options.fs ?? realTradeFs;
    let text: string | undefined;
    try {
      text = this.fs.read(options.file);
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
    }
    const parsed = parseHistoryFile(text);
    if (parsed.issues.length > 0) options.log?.("warn", "trade history sanitized", parsed.issues);
    this.entries = pruneHistory(parsed.entries, options.now(), options.settings().historyRetentionDays);
    this.ignoredIds = new Set(parsed.ignoredIds);
    this.importLedger();
  }

  /** Re-reads the shop ledger only when its size or mtime moved. */
  private importLedger(): void {
    if (!this.options.settings().importShopSales) return;
    let stamp: string | undefined;
    try {
      const stats = this.fs.stat(this.options.shopLedgerFile);
      if (!stats) return;
      stamp = `${stats.size}:${stats.mtimeMs}`;
    } catch (error) {
      this.ledgerError = error instanceof Error ? error.message : String(error);
      return;
    }
    if (stamp === this.ledgerStamp) return;
    this.ledgerStamp = stamp;
    try {
      const text = this.fs.read(this.options.shopLedgerFile);
      if (!text) return;
      const ledger = shopLedgerEntries(
        parseListingEvents(text),
        this.options.now(),
        this.options.settings().historyRetentionDays,
      );
      const merged = mergeShopLedger(this.entries, ledger, this.ignoredIds);
      this.entries = merged.entries;
      this.ledgerError = undefined;
      if (merged.imported > 0) {
        this.options.log?.("info", "shop ledger rows imported", { count: merged.imported });
        this.persist();
      }
    } catch (error) {
      this.ledgerError = error instanceof Error ? error.message : String(error);
      this.options.log?.("warn", "shop ledger could not be imported", { error: this.ledgerError });
    }
  }

  view(): TradeHistoryView {
    this.importLedger();
    const view: TradeHistoryView = {
      entries: sortHistory(this.entries),
      totals: historyTotals(this.entries, this.options.priceTable()),
      retentionDays: this.options.settings().historyRetentionDays,
      file: this.options.file,
      // The label reads "n from the shop ledger", so it must count the rows
      // that ARE from the ledger — not the delta of the last import, which is
      // 0 on every run after the first (they are already in the file).
      shopLedger: {
        file: this.options.shopLedgerFile,
        imported: this.entries.filter((entry) => entry.matched === "shop-ledger").length,
      },
    };
    if (this.ledgerError) view.shopLedger.lastError = this.ledgerError;
    if (this.lastError) view.lastError = this.lastError;
    return view;
  }

  add(entry: TradeHistoryEntry): TradeHistoryView {
    if (!this.entries.some((row) => row.id === entry.id)) {
      this.entries = pruneHistory(
        [entry, ...this.entries],
        this.options.now(),
        this.options.settings().historyRetentionDays,
      );
      this.persist();
    }
    return this.view();
  }

  /** Throws `Error("trade-history-invalid:<field>")` so the channel can report the field. */
  save(edit: TradeHistoryEdit): TradeHistoryView {
    const result = applyHistoryEdit(
      this.entries,
      edit,
      this.options.now(),
      this.options.priceTable(),
      this.options.rand,
    );
    if ("error" in result) throw new Error(result.error);
    this.entries = pruneHistory(
      result.entries,
      this.options.now(),
      this.options.settings().historyRetentionDays,
    );
    this.persist();
    return this.view();
  }

  remove(id: string): TradeHistoryView {
    const target = this.entries.find((entry) => entry.id === id);
    this.entries = this.entries.filter((entry) => entry.id !== id);
    // A deleted ledger row must stay deleted: the next import would otherwise
    // recreate it from the same journal line. The cap is enforced HERE (oldest
    // first) so what is in memory is what gets serialized — trimming only on
    // write would silently forget ids the session still believes it holds.
    if (target?.matched === "shop-ledger") {
      this.ignoredIds.add(id);
      while (this.ignoredIds.size > MAX_IGNORED_IDS) {
        const oldest = this.ignoredIds.values().next().value;
        if (oldest === undefined) break;
        this.ignoredIds.delete(oldest);
      }
    }
    this.persist();
    return this.view();
  }

  prune(): number {
    const before = this.entries.length;
    this.entries = pruneHistory(
      this.entries,
      this.options.now(),
      this.options.settings().historyRetentionDays,
    );
    if (this.entries.length !== before) this.persist();
    return before - this.entries.length;
  }

  csv(): string {
    return historyToCsv(this.entries);
  }

  count(): number {
    return this.entries.length;
  }

  flush(): void {
    this.persist();
  }

  private persist(): void {
    try {
      this.fs.write(
        this.options.file,
        serializeHistoryFile(this.entries, [...this.ignoredIds], this.options.now()),
      );
      this.lastError = undefined;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.options.log?.("warn", "trade history could not be saved", { error: this.lastError });
    }
  }
}
