import { describe, expect, it, vi } from "vitest";
import { auditPhysicalItems, runDumpValuation, type DumpValuationSorter } from "../src/core/dumpValuationRun.js";
import { defaultStashValuationSettings, type StashMarketQuote, type StashValuationReport } from "../src/core/stashValuation.js";
import { destForItemClass, type IdentifiedItem } from "../src/core/gearSort.js";
import type { TabScanResult } from "../src/adapters/gearSorter.js";

const at = "2026-09-14T12:00:00.000Z";
const settings = { ...defaultStashValuationSettings(), routingMode: "purpose" as const, league: "Forbidden Rites" };
const ring = "Item Class: Rings\nRarity: Rare\nStorm Coil\nGold Ring\n--------\nItem Level: 82\n--------\n+60 to maximum Life";
const currency = "Item Class: Stackable Currency\nRarity: Currency\nChaos Orb\n--------\nStack Size: 3/20";
const quote: StashMarketQuote = { state: "priced", league: settings.league, provider: "trade2", fetchedAt: at,
  currency: "chaos", low: 3, fair: 4, high: 5, sampleSize: 12, candidateCount: 20, confidence: 80, reasons: [] };
const item = (text = ring, col = 0): IdentifiedItem => {
  const itemClass = /Item Class: (.*)/.exec(text)![1]!;
  return { text, itemClass, dest: destForItemClass(itemClass), cells: [{ row: 0, col, x: col * 50, y: 300 }] };
};
const scan = (items: IdentifiedItem[], unread = false): TabScanResult => ({ ok: true, occupiedCount: items.length,
  modelItems: items, reads: items.map(entry => ({ cell: entry.cells[0]!, text: entry.text })),
  unread: unread ? [{ row: 3, col: 4, x: 200, y: 500 }] : [],
  region: { x: 0, y: 0, w: 1200, h: 1200 }, cols: 24, rows: 24,
  coverage: { totalCells: 576, copiedCells: 576, excludedCells: [] } });

function fixture(items = [item()], options: { unread?: boolean; receipt?: boolean; depositFails?: boolean; maskedWithdrawal?: boolean } = {}) {
  let bag: IdentifiedItem[] = [];
  let deposited = false;
  let withdrawn = false;
  const saves: StashValuationReport[] = [];
  const sorter: DumpValuationSorter = {
    scanTab: vi.fn(async source => source.topLevel ? scan(items, options.unread)
      : scan(deposited && options.receipt !== false ? [items[0]!] : [])),
    gotoTab: vi.fn(async () => true),
    bagCellsNow: vi.fn(async () => bag.flatMap(entry => entry.cells)),
    identifyBagItems: vi.fn(async () => ({ items: bag, unread: [] })),
    copyAt: vi.fn(async () => withdrawn ? "" : items[0]!.text),
    withdrawItemsSerial: vi.fn(async entries => { bag = [...entries]; withdrawn = true; return options.maskedWithdrawal ? [] : [...entries]; }),
    depositBagCells: vi.fn(async () => {
      if (options.depositFails) return 1;
      bag = []; deposited = true; return 0;
    }),
  };
  const fetchQuote = vi.fn(async () => quote);
  const run = (mode: "scan" | "move" = "scan") => runDumpValuation({ settings, mode, sorter,
    quote: fetchQuote, now: () => at, onReport: report => saves.push(report) });
  return { sorter, saves, fetchQuote, run };
}

describe("complete Dump valuation workflow", () => {
  it("preserves the denied item, waits for the server deadline, then resumes the full batch", async () => {
    const f = fixture([item(), item(currency, 2)]);
    let time = Date.parse(at);
    const retryAfter = new Date(time + 1000).toISOString();
    f.fetchQuote.mockResolvedValueOnce({ ...quote, state: "unavailable", retryAfter, reasons: ["HTTP 429"] });
    const result = await runDumpValuation({ settings, mode: "scan", sorter: f.sorter, quote: f.fetchQuote,
      now: () => new Date(time).toISOString(), sleep: async ms => { time += ms; }, onReport: r => f.saves.push(r) });
    expect(time).toBe(Date.parse(retryAfter) + 250);
    expect(f.fetchQuote).toHaveBeenCalledTimes(3);
    expect(f.saves.some(r => r.rows[0]?.quote.retryAfter === retryAfter && r.rows.length === 2)).toBe(true);
    expect(result.status).toBe("complete");
    expect(f.sorter.withdrawItemsSerial).not.toHaveBeenCalled();
  });

  it("cancels a rate-limit wait without sending the retry", async () => {
    const f = fixture();
    f.fetchQuote.mockResolvedValueOnce({ ...quote, state: "unavailable", retryAfter: "2026-09-14T12:01:00Z" });
    const result = await runDumpValuation({ settings, mode: "scan", sorter: f.sorter, quote: f.fetchQuote,
      now: () => at, onReport: r => f.saves.push(r), checkpoint: async message => {
        if (message.startsWith("market restriction")) { const error = new Error("Stopped"); error.name = "SortStop"; throw error; }
      } });
    expect(result.status).toBe("stopped");
    expect(result.scannedItems).toBe(1);
    expect(f.fetchQuote).toHaveBeenCalledTimes(1);
  });

  it("copies and prices every item, including non-gear, with no transfers during scan", async () => {
    const f = fixture([item(), item(currency, 2)]);
    const result = await f.run();
    expect(f.sorter.scanTab).toHaveBeenCalledWith({ label: "Dump", occurrence: 0, topLevel: true }, { exhaustive: true });
    expect(f.fetchQuote).toHaveBeenCalledTimes(2);
    expect(result.rows.map(row => row.itemClass)).toEqual(["Rings", "Stackable Currency"]);
    expect(result.rows.every(row => row.status === "planned")).toBe(true);
    expect(f.sorter.withdrawItemsSerial).not.toHaveBeenCalled();
    expect(result.status).toBe("complete");
    expect(f.saves.some(report => report.rows.length === 2 && report.rows.every(row => row.quote.state === "unavailable"))).toBe(true);
  });

  it("retains adjacent identical one-cell items as separate physical rows", () => {
    const first = item();
    expect(auditPhysicalItems([{ ...first, cells: [first.cells[0]!, { ...first.cells[0]!, col: 1 }] }])).toHaveLength(2);
  });

  it("splits identical adjacent helmets by their fully observed 2x2 footprints", () => {
    const helmet = item(ring.replace("Rings", "Helmets"));
    helmet.cells = Array.from({ length: 8 }, (_, index) => ({ row: Math.floor(index / 4), col: index % 4, x: 0, y: 0 }));
    expect(auditPhysicalItems([helmet]).map(part => part.cells.length)).toEqual([4, 4]);
  });

  it("uses the user's class tabs for valuable gear and retains non-gear without a configured destination", async () => {
    const f = fixture([item(), item(currency, 2)]);
    const result = await runDumpValuation({ settings: { ...settings, routingMode: "class" }, mode: "scan",
      sorter: f.sorter, quote: f.fetchQuote, now: () => at, onReport: () => undefined });
    expect(result.rows[0]).toMatchObject({ status: "planned", destination: "Rings" });
    expect(result.rows[1]).toMatchObject({ status: "stay", destination: "Dump", decision: "review" });
  });

  it("continues pricing every item after provider failure and reports incompleteness", async () => {
    const f = fixture([item(), item(currency, 2)]);
    f.fetchQuote.mockRejectedValueOnce(new Error("outage"));
    const result = await f.run();
    expect(f.fetchQuote).toHaveBeenCalledTimes(2);
    expect(result.status).toBe("incomplete");
    expect(result.rows[0]!.decision).toBe("review");
    expect(result.rows[0]!.actualDestination).toBeUndefined();
  });

  it("persists unread cells and refuses transfers from an incomplete source scan", async () => {
    const f = fixture([item()], { unread: true });
    const result = await f.run("move");
    expect(result.unreadCells).toEqual([{ row: 3, col: 4, reason: expect.any(String) }]);
    expect(f.sorter.withdrawItemsSerial).not.toHaveBeenCalled();
    expect(result.errors.join(" ")).toContain("coverage is incomplete");
  });

  it("marks moved only after source, bag, and destination receipt verification", async () => {
    const f = fixture();
    const result = await f.run("move");
    expect(result.status).toBe("complete");
    expect(result.rows[0]).toMatchObject({ status: "moved", actualDestination: "Sell" });
    expect(f.fetchQuote).toHaveBeenCalledTimes(1);
    expect(f.sorter.depositBagCells).toHaveBeenCalledWith([item().cells[0]], "Sell", { shiftOnly: true });
    expect(f.saves.filter(report => report.rows[0]?.status === "moved")).not.toHaveLength(0);
  });

  it("never reports an unobserved destination as moved", async () => {
    const f = fixture([item()], { receipt: false });
    const result = await f.run("move");
    expect(result.rows[0]).toMatchObject({ status: "failed" });
    expect(result.rows[0]!.actualDestination).toBeUndefined();
    expect(result.errors.join(" ")).toContain("Destination receipt could not be verified");
  });

  it("recovers masked bag growth only with exact item text, quantity, and an empty source cell", async () => {
    const f = fixture([item()], { maskedWithdrawal: true });
    const result = await f.run("move");
    expect(result.status).toBe("complete");
    expect(result.rows[0]).toMatchObject({ status: "moved", actualDestination: "Sell" });
    expect(result.rows[0]!.reasons.join(" ")).toContain("exact inventory item text and quantity plus an empty original source cell");
    expect(f.saves.some(saved => saved.rows[0]?.actualDestination === "inventory (unconfirmed)")).toBe(true);
    expect(f.sorter.withdrawItemsSerial).toHaveBeenCalledTimes(1);
    expect(f.sorter.identifyBagItems).toHaveBeenCalledTimes(1);
    expect(f.sorter.copyAt).toHaveBeenCalledTimes(2);
    expect(f.sorter.depositBagCells).toHaveBeenCalledTimes(1);
  });

  it.each(["wrong item", "wrong quantity", "unread cell", "multiple items", "no item", "source still present"])(
    "stops without another withdrawal or deposit when masked growth has %s", async failure => {
      const source = failure === "wrong quantity" ? item(currency) : item();
      const f = fixture([source], { maskedWithdrawal: true });
      if (failure === "wrong item") vi.mocked(f.sorter.identifyBagItems).mockResolvedValue({ items: [item(currency)], unread: [] });
      if (failure === "wrong quantity") vi.mocked(f.sorter.identifyBagItems).mockResolvedValue({ items: [item(currency.replace("3/20", "2/20"))], unread: [] });
      if (failure === "unread cell") vi.mocked(f.sorter.identifyBagItems).mockResolvedValue({ items: [source], unread: [{ row: 2, col: 0, x: 0, y: 400 }] });
      if (failure === "multiple items") vi.mocked(f.sorter.identifyBagItems).mockResolvedValue({ items: [source, item(ring, 2)], unread: [] });
      if (failure === "no item") vi.mocked(f.sorter.identifyBagItems).mockResolvedValue({ items: [], unread: [] });
      if (failure === "source still present") vi.mocked(f.sorter.copyAt).mockResolvedValue(source.text);
      const result = await f.run("move");
      expect(result.status).toBe("failed");
      expect(result.rows[0]).toMatchObject({ status: "failed", actualDestination: "inventory (unconfirmed)" });
      expect(result.errors.join(" ")).toContain("exact inventory text and an empty source cell");
      expect(f.sorter.withdrawItemsSerial).toHaveBeenCalledTimes(1);
      expect(f.sorter.depositBagCells).not.toHaveBeenCalled();
      expect(f.saves.every(saved => saved.rows[0]?.status !== "moved")).toBe(true);
    },
  );

  it("stops on a bounced deposit and preserves the actual inventory location", async () => {
    const f = fixture([item()], { depositFails: true });
    const result = await f.run("move");
    expect(result.rows[0]).toMatchObject({ status: "failed", actualDestination: "inventory" });
    expect(f.sorter.depositBagCells).toHaveBeenCalledTimes(1);
  });

  it("refuses to withdraw when source text changed after the price lookup", async () => {
    const f = fixture();
    vi.mocked(f.sorter.copyAt).mockResolvedValue(currency);
    const result = await f.run("move");
    expect(f.sorter.withdrawItemsSerial).not.toHaveBeenCalled();
    expect(result.errors.join(" ")).toContain("identity changed");
  });

  it("requires an empty bag before any transfer", async () => {
    const f = fixture();
    vi.mocked(f.sorter.bagCellsNow).mockResolvedValue(item().cells);
    const result = await f.run("move");
    expect(result.errors.join(" ")).toContain("Empty the inventory");
    expect(f.sorter.withdrawItemsSerial).not.toHaveBeenCalled();
  });

  it("rechecks quote freshness after a slow destination scan, before withdrawal", async () => {
    const f = fixture();
    let clock = at;
    vi.mocked(f.sorter.copyAt).mockImplementation(async () => {
      clock = "2026-09-14T12:02:00.000Z";
      return ring;
    });
    const report = await runDumpValuation({ settings: { ...settings, maxAgeMinutes: 1 }, mode: "move",
      sorter: f.sorter, quote: f.fetchQuote, now: () => clock, onReport: () => undefined });
    expect(f.sorter.withdrawItemsSerial).not.toHaveBeenCalled();
    expect(report.rows[0]).toMatchObject({ status: "stay", destination: "Dump" });
    expect(report.rows[0]!.reasons.join(" ")).toContain("remained expired after destination verification");
    expect(f.fetchQuote).toHaveBeenCalledTimes(2);
  });

  it("refreshes a sale quote that expired while other items were priced", async () => {
    const f = fixture();
    let clock = at;
    f.fetchQuote.mockImplementation(async () => ({ ...quote, fetchedAt: clock }));
    const report = await runDumpValuation({ settings: { ...settings, maxAgeMinutes: 1 }, mode: "move", sorter: f.sorter,
      quote: f.fetchQuote, now: () => clock, onReport: result => f.saves.push(result),
      checkpoint: async message => { if (message.startsWith("verify ")) clock = "2026-09-14T12:02:00.000Z"; } });
    expect(f.fetchQuote).toHaveBeenCalledTimes(2);
    expect(report.rows[0]).toMatchObject({ status: "moved", quote: { fetchedAt: clock } });
    expect(f.saves.some(saved => saved.rows[0]?.quote.fetchedAt === clock && saved.rows[0]?.status === "planned")).toBe(true);
  });

  it("refreshes again after destination verification and rechecks source identity afterwards", async () => {
    const f = fixture();
    let clock = at;
    let copies = 0;
    f.fetchQuote.mockImplementation(async () => ({ ...quote, fetchedAt: clock }));
    vi.mocked(f.sorter.copyAt).mockImplementation(async () => {
      copies += 1; clock = "2026-09-14T12:02:00.000Z"; return ring;
    });
    const report = await runDumpValuation({ settings: { ...settings, maxAgeMinutes: 1 }, mode: "move",
      sorter: f.sorter, quote: f.fetchQuote, now: () => clock, onReport: () => undefined });
    expect(report.rows[0]!.status).toBe("moved");
    expect(f.fetchQuote).toHaveBeenCalledTimes(2);
    expect(copies).toBe(2);
    expect(vi.mocked(f.sorter.copyAt).mock.invocationCallOrder[1]).toBeGreaterThan(f.fetchQuote.mock.invocationCallOrder[1]!);
    expect(vi.mocked(f.sorter.withdrawItemsSerial).mock.invocationCallOrder[0]).toBeGreaterThan(vi.mocked(f.sorter.copyAt).mock.invocationCallOrder[1]!);
  });

  it("does not withdraw an item that changed during the refresh", async () => {
    const f = fixture();
    let clock = at;
    f.fetchQuote.mockImplementation(async () => ({ ...quote, fetchedAt: clock }));
    vi.mocked(f.sorter.copyAt).mockImplementationOnce(async () => {
      clock = "2026-09-14T12:02:00.000Z"; return ring;
    }).mockResolvedValueOnce(currency);
    const report = await runDumpValuation({ settings: { ...settings, maxAgeMinutes: 1 }, mode: "move",
      sorter: f.sorter, quote: f.fetchQuote, now: () => clock, onReport: () => undefined });
    expect(f.sorter.withdrawItemsSerial).not.toHaveBeenCalled();
    expect(report.errors.join(" ")).toContain("identity changed during price refresh");
  });

  it("retains the source on a failed refresh without retrying the network indefinitely", async () => {
    const f = fixture();
    let clock = at;
    f.fetchQuote.mockResolvedValueOnce(quote).mockRejectedValueOnce(new Error("offline"));
    const report = await runDumpValuation({ settings: { ...settings, maxAgeMinutes: 1 }, mode: "move",
      sorter: f.sorter, quote: f.fetchQuote, now: () => clock, onReport: () => undefined,
      checkpoint: async message => { if (message.startsWith("verify ")) clock = "2026-09-14T12:02:00.000Z"; } });
    expect(f.fetchQuote).toHaveBeenCalledTimes(2);
    expect(report.rows[0]).toMatchObject({ status: "stay", destination: "Dump", quote: { state: "unavailable" } });
    expect(f.sorter.withdrawItemsSerial).not.toHaveBeenCalled();
  });

  it("honors the provider expiry boundary and allows at most two refreshes per item", async () => {
    const f = fixture();
    let clock = at;
    f.fetchQuote.mockResolvedValueOnce({ ...quote, validUntil: "2026-09-14T12:01:00.000Z" })
      .mockResolvedValueOnce({ ...quote, fetchedAt: "2026-09-14T12:01:00.000Z", validUntil: "2026-09-14T12:02:00.000Z" })
      .mockResolvedValueOnce({ ...quote, fetchedAt: "2026-09-14T12:02:00.000Z", validUntil: "2026-09-14T12:03:00.000Z" });
    vi.mocked(f.sorter.copyAt).mockImplementation(async () => { clock = "2026-09-14T12:02:00.000Z"; return ring; });
    const report = await runDumpValuation({ settings, mode: "move", sorter: f.sorter,
      quote: f.fetchQuote, now: () => clock, onReport: () => undefined,
      checkpoint: async message => { if (message.startsWith("verify ")) clock = "2026-09-14T12:01:00.000Z"; } });
    expect(f.fetchQuote).toHaveBeenCalledTimes(3); // initial appraisal plus two bounded refreshes
    expect(report.rows[0]!.status).toBe("moved");
  });

  it("can move a crafting candidate independently without refreshing unavailable market evidence", async () => {
    const craftText = ring.replace("+60 to maximum Life", "+162 to maximum Life\n+40% to Chaos Resistance");
    const f = fixture([item(craftText)]);
    f.fetchQuote.mockResolvedValue({ ...quote, state: "unavailable", confidence: 0, sampleSize: 0 });
    const report = await f.run("move");
    expect(report.rows[0]).toMatchObject({ status: "moved", decision: "craft", actualDestination: "Craft" });
    expect(f.fetchQuote).toHaveBeenCalledTimes(1);
  });

  it("persists the full inventory when a stop occurs midway through appraisal", async () => {
    const f = fixture([item(), item(currency, 2)]);
    const stopped = new Error("Emergency stop"); stopped.name = "SortStop";
    const checkpoint = vi.fn(async () => undefined).mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockRejectedValueOnce(stopped);
    const report = await runDumpValuation({ settings, mode: "scan", sorter: f.sorter, quote: f.fetchQuote,
      checkpoint, now: () => at, onReport: result => f.saves.push(result) });
    expect(report.status).toBe("stopped");
    expect(report.rows).toHaveLength(2);
    expect(report.rows[1]!.quote.state).toBe("unavailable");
  });
});
