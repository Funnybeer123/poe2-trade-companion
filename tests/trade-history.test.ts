import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseListingEvents } from "../src/core/shopListings.js";
import type { PriceTable } from "../src/core/priceTable.js";
import {
  applyHistoryEdit,
  historyToCsv,
  historyTotals,
  mergeShopLedger,
  newHistoryId,
  parseHistoryFile,
  pruneHistory,
  sanitizeHistoryEntry,
  serializeHistoryFile,
  shopLedgerEntries,
  sortHistory,
} from "../src/core/tradeHistory.js";
import type { TradeHistoryEntry } from "../src/shared/trade.js";

const SAMPLE = readFileSync(path.join(process.cwd(), "fixtures", "trade", "history-sample.json"), "utf8");
const LEDGER = readFileSync(path.join(process.cwd(), "fixtures", "trade", "listings-sold.jsonl"), "utf8");
const NOW = "2026-09-20T12:00:00.000Z";

const TABLE: PriceTable = {
  schemaVersion: 1,
  currency: "exalted",
  entries: [{ id: "divine", match: { name: "Divine Orb" }, value: 500 }],
};

function entries(): TradeHistoryEntry[] {
  return parseHistoryFile(SAMPLE).entries;
}

describe("history file parsing", () => {
  it("reads the sample, sorted newest first", () => {
    const parsed = parseHistoryFile(SAMPLE);
    expect(parsed.entries).toHaveLength(6);
    expect(parsed.entries[0].player).toBe("Buyerino");
    expect(parsed.issues).toEqual([]);
  });

  it("drops junk rows and duplicate ids, and reports it", () => {
    const parsed = parseHistoryFile(
      JSON.stringify({
        version: 1,
        entries: [
          { id: "th_a", at: "2026-09-19T20:00:00.000Z", kind: "sale", item: { name: "X" }, price: { amount: 1, currency: "exalted" } },
          { id: "th_a", at: "2026-09-19T20:00:00.000Z", kind: "sale", item: { name: "X" }, price: { amount: 1, currency: "exalted" } },
          { id: "th_b", at: "not a date", kind: "sale", item: { name: "X" }, price: { amount: 1, currency: "exalted" } },
          { id: "th_c", at: "2026-09-19T20:00:00.000Z", kind: "gift", item: { name: "X" }, price: { amount: 1, currency: "exalted" } },
          "nonsense",
        ],
        ignoredIds: ["shop_x_1", 42],
      }),
    );
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.ignoredIds).toEqual(["shop_x_1"]);
    expect(parsed.issues.join(" ")).toContain("dropped");
    expect(parseHistoryFile("nope").issues.join(" ")).toContain("not valid JSON");
    expect(sanitizeHistoryEntry({ id: "x", at: NOW, kind: "sale", item: {}, price: { amount: 1 } })).toBeUndefined();
  });

  it("round-trips and keeps the fields the session recap reads", () => {
    const text = serializeHistoryFile(entries(), ["shop_gone_1"], NOW);
    const back = parseHistoryFile(text);
    expect(back.entries).toHaveLength(6);
    expect(back.ignoredIds).toEqual(["shop_gone_1"]);
    for (const entry of back.entries) {
      expect(typeof entry.at).toBe("string");
      expect(["sale", "purchase", "unknown"]).toContain(entry.kind);
      expect("exalted" in entry.price || entry.price.currency === "").toBe(true);
    }
  });

  it("makes a readable, unique id", () => {
    expect(newHistoryId(NOW, () => "abcd")).toBe("th_2026-09-20T12-00-00-000Z_abcd");
  });
});

describe("retention and totals", () => {
  it("prunes by the retention window", () => {
    const kept = pruneHistory(entries(), NOW, 14);
    expect(kept).toHaveLength(4);
    expect(kept.every((entry) => entry.at >= "2026-09-06")).toBe(true);
    expect(pruneHistory(entries(), NOW, 90)).toHaveLength(6);
  });

  it("adds up earnings, spendings and profit at the current rate", () => {
    const totals = historyTotals(pruneHistory(entries(), NOW, 14), TABLE);
    expect(totals.sales).toBe(3);
    expect(totals.purchases).toBe(1);
    expect(totals.divineRate).toBe(500);
    expect(totals.divineRateSource).toBe("price-table");
    expect(totals.earningsExalted).toBe(51);
    expect(totals.spendingsExalted).toBe(750);
    expect(totals.profitExalted).toBe(-699);
    expect(totals.byCurrency.exalted).toEqual({ sales: 51, purchases: 0 });
  });

  it("counts rows it cannot price and reports the fallback rate", () => {
    const totals = historyTotals(entries(), undefined);
    expect(totals.unpriced).toBe(1);
    expect(totals.divineRateSource).toBe("fallback");
    expect(totals.unknown).toBe(1);
  });
});

describe("manual edits", () => {
  it("adds a row and recomputes the exalted estimate", () => {
    const result = applyHistoryEdit(
      [],
      { at: NOW, kind: "sale", player: "Buyerino", item: { name: "Ghoul Lash" }, price: { amount: 2, currency: "divine" } },
      NOW,
      TABLE,
      () => "abcd",
    );
    expect("entry" in result).toBe(true);
    if (!("entry" in result)) return;
    expect(result.entry.price.exalted).toBe(1000);
    expect(result.entry.price.currencyId).toBe("divine");
    expect(result.entry.matched).toBe("manual");
    expect(result.entry.editedAt).toBeUndefined();
  });

  it("edits an existing row and stamps editedAt", () => {
    const rows = entries();
    const result = applyHistoryEdit(rows, { id: rows[0].id, note: "handed over in town" }, NOW, TABLE);
    expect("entry" in result).toBe(true);
    if (!("entry" in result)) return;
    expect(result.entry.note).toBe("handed over in town");
    expect(result.entry.editedAt).toBe(NOW);
    expect(result.entries).toHaveLength(rows.length);
  });

  it("names the field it refused", () => {
    const rows = entries();
    expect(applyHistoryEdit(rows, { id: rows[0].id, price: { amount: -5, currency: "exalted" } }, NOW)).toEqual({
      error: "trade-history-invalid:price.amount",
    });
    expect(applyHistoryEdit(rows, { id: "nope" }, NOW)).toEqual({ error: "trade-history-invalid:id" });
    expect(applyHistoryEdit(rows, { id: rows[0].id, at: "whenever" }, NOW)).toEqual({
      error: "trade-history-invalid:at",
    });
  });
});

describe("CSV", () => {
  it("quotes, uses CRLF and starts with a BOM so Excel opens it", () => {
    const csv = historyToCsv(entries());
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const lines = csv.slice(1).split("\r\n");
    expect(lines[0]).toBe(
      "at,kind,player,item,base_type,quantity,amount,currency,exalted_estimate,league,secure,matched,note",
    );
    expect(lines.some((line) => line.includes('"sold two, one, ""as is"""'))).toBe(true);
    expect(lines[1]).toContain("Buyerino");
  });

  it("neutralises a counterparty-controlled value that Excel would run as a formula", () => {
    const rows = entries().slice(0, 1).map((entry) => ({
      ...entry,
      player: "=cmd|'/c calc'!A1",
      item: { ...entry.item, name: "=HYPERLINK(\"http://evil/\",\"click\")" },
      note: "@SUM(A1:A9)",
    }));
    const line = historyToCsv(rows).slice(1).split("\r\n")[1];
    expect(line).toContain("\"'=cmd|'/c calc'!A1\"");
    expect(line).toContain("\"'=HYPERLINK(\"\"http://evil/\"\",\"\"click\"\")\"");
    expect(line).toContain("\"'@SUM(A1:A9)\"");
    // A harmless value is still written bare — the escape is not blanket.
    expect(line.split(",")[1]).toBe(rows[0].kind);
  });
});

describe("shop ledger import", () => {
  it("only takes verified sales with a realized price", () => {
    const rows = shopLedgerEntries(parseListingEvents(LEDGER), "2026-09-05T00:00:00.000Z", 14);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "shop_ab12cd34_2026-09-03T18-02-11-000Z",
      kind: "sale",
      player: "",
      secure: "yes",
      matched: "shop-ledger",
    });
    expect(rows[0].price).toEqual({ amount: 1, currency: "exalted" });
  });

  it("drops a verified sale the journal wrote without an item name", () => {
    const events = parseListingEvents(LEDGER);
    const nameless = events.find((event) => event.fingerprint === "9f9f9f9f");
    expect(nameless).toBeDefined();
    expect(nameless?.name).toBeUndefined();
    const rows = shopLedgerEntries(events, "2026-09-05T00:00:00.000Z", 90);
    expect(rows.every((row) => typeof row.item.name === "string" && row.item.name.length > 0)).toBe(true);
    expect(rows.some((row) => row.id.includes("9f9f9f9f"))).toBe(false);
  });

  it("is idempotent, honours ignoredIds and never overwrites an edited row", () => {
    const ledger = shopLedgerEntries(parseListingEvents(LEDGER), "2026-09-05T00:00:00.000Z", 14);
    const first = mergeShopLedger([], ledger, new Set());
    expect(first.imported).toBe(1);
    const second = mergeShopLedger(first.entries, ledger, new Set());
    expect(second.imported).toBe(0);
    const edited = first.entries.map((entry) => ({ ...entry, note: "mine" }));
    const third = mergeShopLedger(edited, ledger, new Set());
    expect(third.entries[0].note).toBe("mine");
    const ignored = mergeShopLedger([], ledger, new Set([ledger[0].id]));
    expect(ignored.imported).toBe(0);
  });

  it("sorts newest first, ties broken by id", () => {
    const rows = sortHistory([
      { ...entries()[0], id: "b", at: NOW },
      { ...entries()[0], id: "a", at: NOW },
    ]);
    expect(rows.map((row) => row.id)).toEqual(["a", "b"]);
  });
});
