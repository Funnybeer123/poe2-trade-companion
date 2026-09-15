import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryTradeFs, realTradeFs, type TradeFs } from "../src/main/features/trade/fs.js";
import { TradeHistoryStore } from "../src/main/features/trade/historyStore.js";
import { TradeOfferStore } from "../src/main/features/trade/offerStore.js";
import { serializeOffersFile } from "../src/core/tradeOffers.js";
import { DEFAULT_TRADE_SETTINGS, type TradeOffer, type TradeSettings } from "../src/shared/trade.js";

const NOW = "2026-09-20T12:00:00.000Z";
const OFFERS_FILE = "C:/user/trade-offers.json";
const HISTORY_FILE = "C:/user/trade-history.json";
const LEDGER_FILE = "C:/cfg/listings.jsonl";
const LEDGER = readFileSync(path.join(process.cwd(), "fixtures", "trade", "listings-sold.jsonl"), "utf8");
const SAMPLE = readFileSync(path.join(process.cwd(), "fixtures", "trade", "history-sample.json"), "utf8");

function offer(overrides: Partial<TradeOffer> = {}): TradeOffer {
  return {
    id: "offer_1",
    direction: "incoming",
    kind: "item",
    player: "Buyerino",
    at: NOW,
    updatedAt: NOW,
    repeats: 1,
    item: { name: "Ghoul Lash", baseType: "Long Belt", display: "Ghoul Lash, Long Belt" },
    price: { amount: 1, currency: "exalted", text: "1 exalted" },
    league: "Forbidden Rites",
    secure: "no",
    language: "en",
    templateTested: true,
    raw: "raw whisper",
    state: "new",
    stateAt: NOW,
    transitions: [{ at: NOW, state: "new", via: "whisper" }],
    notified: { windows: false, toast: false, sound: false, discord: false, telegram: false },
    ...overrides,
  };
}

function settings(overrides: Partial<TradeSettings> = {}): TradeSettings {
  return { ...DEFAULT_TRADE_SETTINGS, ...overrides };
}

describe("realTradeFs", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "trade-fs-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes atomically, stats and removes", () => {
    const file = path.join(dir, "nested", "trade-offers.json");
    realTradeFs.write(file, "hello");
    expect(realTradeFs.read(file)).toBe("hello");
    expect(readdirSync(path.dirname(file)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(realTradeFs.stat(file)?.size).toBe(5);
    realTradeFs.remove(file);
    expect(existsSync(file)).toBe(false);
    expect(() => realTradeFs.remove(file)).not.toThrow();
    expect(realTradeFs.read(file)).toBeUndefined();
    expect(realTradeFs.stat(file)).toBeUndefined();
  });
});

describe("TradeOfferStore", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("loads what was persisted and prunes what expired", () => {
    const stale = offer({ id: "offer_old", updatedAt: "2026-09-19T00:00:00.000Z" });
    const fs = memoryTradeFs({ [OFFERS_FILE]: serializeOffersFile([offer(), stale], NOW) });
    const store = new TradeOfferStore({ file: OFFERS_FILE, now: () => NOW, settings, fs });
    expect(store.list()).toHaveLength(2);
    expect(store.get("offer_old")?.state).toBe("dismissed");
    expect(store.active()).toHaveLength(1);
  });

  it("keeps memory first and coalesces the debounced write", () => {
    vi.useFakeTimers();
    const fs = memoryTradeFs();
    const store = new TradeOfferStore({ file: OFFERS_FILE, now: () => NOW, settings, fs, debounceMs: 250 });
    store.replace([offer()]);
    store.replace([offer(), offer({ id: "offer_2" })]);
    expect(fs.files.has(OFFERS_FILE)).toBe(false);
    vi.advanceTimersByTime(300);
    expect(JSON.parse(fs.files.get(OFFERS_FILE) ?? "{}").offers).toHaveLength(2);
    expect(store.lastError).toBeUndefined();
  });

  it("degrades to lastError when the disk refuses, keeping the offers in memory", () => {
    const fs: TradeFs = {
      ...memoryTradeFs(),
      write: () => {
        throw new Error("EPERM");
      },
    };
    const log = vi.fn();
    const store = new TradeOfferStore({ file: OFFERS_FILE, now: () => NOW, settings, fs, log });
    store.replace([offer()]);
    store.flush();
    expect(store.lastError).toBe("EPERM");
    expect(store.list()).toHaveLength(1);
    expect(log).toHaveBeenCalled();
  });

  it("writes `version: 1` pretty JSON on flush", () => {
    const fs = memoryTradeFs();
    const store = new TradeOfferStore({ file: OFFERS_FILE, now: () => NOW, settings, fs });
    store.replace([offer()]);
    store.flush();
    const text = fs.files.get(OFFERS_FILE) ?? "";
    expect(text).toContain('"version": 1');
    expect(text.split("\n").length).toBeGreaterThan(5);
  });
});

describe("TradeHistoryStore", () => {
  function store(files: Record<string, string> = {}, overrides: Partial<TradeSettings> = {}) {
    const fs = memoryTradeFs(files);
    const instance = new TradeHistoryStore({
      file: HISTORY_FILE,
      shopLedgerFile: LEDGER_FILE,
      now: () => NOW,
      settings: () => settings(overrides),
      priceTable: () => undefined,
      fs,
      rand: () => "abcd",
    });
    return { instance, fs };
  }

  it("prunes on load and imports the ledger once", () => {
    const { instance, fs } = store({ [HISTORY_FILE]: SAMPLE, [LEDGER_FILE]: LEDGER });
    const view = instance.view();
    expect(view.entries).toHaveLength(4);
    // "n from the shop ledger" counts the rows in the table that came from it
    // (the sample already holds one); the 2026-09-03 journal line is older
    // than the 14-day window, so nothing new is imported.
    expect(view.shopLedger.imported).toBe(1);
    expect(view.entries.filter((entry) => entry.matched === "shop-ledger")).toHaveLength(1);
    expect(view.retentionDays).toBe(14);
    expect(fs.files.get(HISTORY_FILE)).toContain('"version": 1');
  });

  it("re-reads the ledger only after it changed", () => {
    const { instance, fs } = store({ [HISTORY_FILE]: SAMPLE, [LEDGER_FILE]: "" }, { historyRetentionDays: 90 });
    // Only the row the sample already carries; the journal is still empty.
    expect(instance.view().shopLedger.imported).toBe(1);
    const reads: string[] = [];
    const originalRead = fs.read;
    fs.read = (file: string) => {
      reads.push(file);
      return originalRead(file);
    };
    instance.view();
    expect(reads).not.toContain(LEDGER_FILE);
    fs.write(LEDGER_FILE, LEDGER);
    const after = instance.view();
    expect(reads).toContain(LEDGER_FILE);
    // The sample's row plus the one the journal just contributed.
    expect(after.shopLedger.imported).toBe(2);
  });

  it("still counts the ledger rows it holds after a restart", () => {
    const fs = memoryTradeFs({ [LEDGER_FILE]: LEDGER });
    const options = {
      file: HISTORY_FILE,
      shopLedgerFile: LEDGER_FILE,
      now: () => NOW,
      settings: () => settings({ historyRetentionDays: 90 }),
      priceTable: () => undefined,
      fs,
    };
    expect(new TradeHistoryStore(options).view().shopLedger.imported).toBe(1);
    // Second start: the row is already in trade-history.json, so the import
    // delta is 0 — the number beside "from the shop ledger" must not be.
    const restarted = new TradeHistoryStore(options);
    expect(restarted.view().shopLedger.imported).toBe(1);
    expect(restarted.view().entries).toHaveLength(1);
  });

  it("adds, edits, deletes and remembers a deleted ledger row", () => {
    const { instance } = store({ [LEDGER_FILE]: LEDGER }, { historyRetentionDays: 90 });
    const imported = instance.view();
    expect(imported.entries).toHaveLength(1);
    const ledgerId = imported.entries[0].id;

    const added = instance.save({
      at: NOW,
      kind: "sale",
      player: "Buyerino",
      item: { name: "Ghoul Lash" },
      price: { amount: 2, currency: "exalted" },
    });
    expect(added.entries).toHaveLength(2);

    expect(() => instance.save({ id: "nope" })).toThrow("trade-history-invalid:id");

    const removed = instance.remove(ledgerId);
    expect(removed.entries).toHaveLength(1);
    const again = instance.view();
    expect(again.entries.some((entry) => entry.id === ledgerId)).toBe(false);
  });

  it("exports the CSV it holds and prunes on demand", () => {
    const { instance } = store({ [HISTORY_FILE]: SAMPLE }, { historyRetentionDays: 90, importShopSales: false });
    expect(instance.count()).toBe(6);
    expect(instance.csv().split("\r\n")).toHaveLength(8);
    const pruned = new TradeHistoryStore({
      file: HISTORY_FILE,
      shopLedgerFile: LEDGER_FILE,
      now: () => NOW,
      settings: () => settings({ historyRetentionDays: 5, importShopSales: false }),
      priceTable: () => undefined,
      fs: memoryTradeFs({ [HISTORY_FILE]: SAMPLE }),
    });
    expect(pruned.count()).toBe(2);
    expect(pruned.prune()).toBe(0);
  });
});
