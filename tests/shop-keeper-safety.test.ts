import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ShopKeeper } from "../src/adapters/shopKeeper.js";
import type { GearSorter } from "../src/adapters/gearSorter.js";
import type { SortHarness } from "../src/adapters/sortHarness.js";
import type { OcrLine, StashTabKit, StripEntry } from "../src/adapters/stashTabKit.js";
import type { GridCell, IdentifiedItem } from "../src/core/gearSort.js";
import { parseItemText } from "../src/core/parseItem.js";
import { starterPriceTable, type PriceTable } from "../src/core/priceTable.js";
import {
  bucketTabs,
  defaultShopConfig,
  parseListingEvents,
  type ActiveListing,
  type ShopConfig,
} from "../src/core/shopListings.js";
import { planBucketLadder } from "../src/core/shopPricing.js";
import type { CompsSummary } from "../src/core/tradeComps.js";
import type { TierVerdict } from "../src/core/valueTiers.js";

/**
 * Safety review of the shop keeper (docs/HANDOFF-shop-listings.md): a
 * dry-run never writes the ledger, every unverified gesture stops with a
 * screenshot instead of guessing, the put-back click is only sent when an
 * item can actually be on the cursor, and the keeper prices off the LIVE
 * table. All against fakes — nothing here drives the game.
 */

function table(divine = 40): PriceTable {
  const base = starterPriceTable();
  return { ...base, entries: [...base.entries, { id: "test-divine", match: { name: "Divine Orb" }, value: divine }] };
}

const RING_TEXT = [
  "Item Class: Rings",
  "Rarity: Rare",
  "Doom Loop",
  "Gold Ring",
  "--------",
  "Item Level: 78",
  "--------",
  "+25% to Fire Resistance",
  "+41 to maximum Life",
].join("\n");

const UNIQUE_TEXT = (name: string) =>
  ["Item Class: Amulets", "Rarity: Unique", name, "Gold Amulet", "--------", "Item Level: 80"].join("\n");

const RING_CELL: GridCell = { row: 0, col: 0, x: 100, y: 400 };
const BAG_CELL: GridCell = { row: 0, col: 0, x: 3000, y: 1000 };

function ringInTab(cell: GridCell = RING_CELL): IdentifiedItem {
  return { dest: "junk", itemClass: "Rings", text: RING_TEXT, cells: [cell] };
}

function line(text: string, x: number, y: number, w = 220, h = 28): OcrLine {
  return { text, x, y, w, h };
}

/** A hover tooltip reading "Asking Price: Nx Exalted Orb". */
function tooltip(amount: number): OcrLine[] {
  return [line("Asking Price:", 150, 560), line(`${amount}x Exalted Orb`, 120, 610, 260)];
}

const ONE_EX = { amount: 1, currency: "exalted", exalted: 1 };

interface FakeOptions {
  dryRun?: boolean;
  stepMode?: boolean;
  config?: Partial<ShopConfig>;
  /** Text every OCR band returns (default: Merchant + inventory open). */
  bandText?: string;
  /** Lines kit.settledOcr returns (tooltips, dialog anchors). */
  ocrLines?: OcrLine[];
  strip?: { top?: StripEntry[]; folder?: StripEntry[] };
  tabItems?: IdentifiedItem[];
  bagItems?: IdentifiedItem[];
  /** Successive bagCellsNow() answers; the last one repeats. */
  bagCells?: GridCell[][];
  copyAt?: (x: number, y: number) => string;
  confirmVerdict?: "good" | "wrong";
  priceTable?: PriceTable;
  getPriceTable?: () => PriceTable;
  evaluate?: (text: string) => TierVerdict;
  comps?: (text: string) => Promise<CompsSummary | undefined | "rate-limited">;
  assumeCurrentTab?: boolean;
}

function fakeKeeper(root: string, options: FakeOptions = {}) {
  const ops: string[] = [];
  const clicks: string[] = [];
  const checkpoints: string[] = [];
  const plans: string[] = [];
  const bursts: string[] = [];
  const scans: Array<{ source: unknown; options: unknown }> = [];
  const logs: string[] = [];
  const bagAnswers = [...(options.bagCells ?? [[]])];
  const host = {
    async send(payload: Record<string, unknown>) {
      ops.push(String(payload.op));
      if (payload.op === "ocr") return { ok: true, text: options.bandText ?? "MERCHANT INVENTORY", lines: [] };
      return { ok: true };
    },
  };
  const harness = {
    async click(_x: number, _y: number, why: string) {
      clicks.push(why);
      return "clicked" as const;
    },
    async sleep() {},
    async checkpoint(where: string) {
      checkpoints.push(where);
    },
    async confirmPlan(_rects: unknown, label: string) {
      plans.push(label);
      return options.confirmVerdict ?? ("good" as const);
    },
    async burst(_targets: unknown, burstOptions: { label: string }) {
      bursts.push(burstOptions.label);
      return options.dryRun ? 0 : 1;
    },
  } as unknown as SortHarness;
  const kit = {
    async readStrip() {
      return { top: options.strip?.top ?? [], folder: options.strip?.folder ?? [] };
    },
    async settledOcr() {
      return options.ocrLines ?? [];
    },
  } as unknown as StashTabKit;
  const sorter = {
    async scanTab(source: unknown, scanOptions: unknown) {
      scans.push({ source, options: scanOptions });
      const items = options.tabItems ?? [];
      return {
        ok: true,
        occupiedCount: items.length,
        modelItems: items,
        reads: [],
        unread: [],
        region: { x: 35, y: 317, w: 1273, h: 1277 },
        cols: 12,
        rows: 12,
      };
    },
    async bagCellsNow() {
      return bagAnswers.length > 1 ? bagAnswers.shift()! : bagAnswers[0]!;
    },
    async copyAt(x: number, y: number) {
      return options.copyAt?.(x, y) ?? "";
    },
    async identifyBagItems() {
      return { items: options.bagItems ?? [], unread: [] };
    },
    async occupiedStashCellsNow() {
      return [];
    },
    async withdrawItemsSerial() {
      return [];
    },
    async ensureSession() {},
  } as unknown as GearSorter;
  const keeper = new ShopKeeper(host, harness, kit, sorter, {
    root,
    config: { ...defaultShopConfig(), shopTab: "1Ex", ...options.config },
    dryRun: options.dryRun ?? true,
    stepMode: options.stepMode ?? false,
    priceTable: options.priceTable ?? table(),
    ...(options.getPriceTable ? { getPriceTable: options.getPriceTable } : {}),
    ...(options.evaluate ? { evaluate: options.evaluate } : {}),
    ...(options.comps ? { comps: options.comps } : {}),
    ...(options.assumeCurrentTab ? { assumeCurrentTab: true } : {}),
    log: (lineText) => logs.push(lineText),
    now: () => new Date("2026-09-07T12:00:00.000Z"),
  });
  const ledgerFile = path.join(root, "artifacts", "tab-admin", "listings.jsonl");
  const ledger = () => (existsSync(ledgerFile) ? parseListingEvents(readFileSync(ledgerFile, "utf8")) : []);
  return { keeper, ops, clicks, checkpoints, plans, bursts, scans, logs, ledger };
}

function withRoot(run: (root: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const root = mkdtempSync(path.join(tmpdir(), "shop-safety-"));
    try {
      await run(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

describe("scan geometry and navigation guards", () => {
  it(
    "scans the shop tab as a shop source (12x12 pin, cleanTab refusal)",
    withRoot(async (root) => {
      const { keeper, scans } = fakeKeeper(root, { assumeCurrentTab: true });
      await keeper.scan();
      expect(scans[0]!.source).toMatchObject({ label: "1Ex", occurrence: 0, shop: true });
      expect(scans[0]!.options).toMatchObject({ navigate: false });
    }),
  );

  it(
    "refuses to open the Merchant while the stash panel is up — no click",
    withRoot(async (root) => {
      const { keeper, clicks, ops, logs } = fakeKeeper(root, { bandText: "STASH" });
      expect(await keeper.ensureMerchantOpen()).toBe(false);
      expect(clicks).toEqual([]);
      expect(ops).not.toContain("click");
      expect(logs.some((entry) => /stash panel is open/.test(entry))).toBe(true);
    }),
  );

  it(
    "values the strip's buckets off the LIVE table, not the one it was built with",
    withRoot(async (root) => {
      const { keeper } = fakeKeeper(root, {
        strip: { folder: [{ label: "1D", row: "folder", point: { x: 300, y: 288 }, width: 60 }] },
        priceTable: table(40),
        getPriceTable: () => table(100),
      });
      const buckets = await keeper.readBucketTabs();
      expect(buckets.map((bucket) => [bucket.label, bucket.exalted])).toEqual([["1D", 100]]);
    }),
  );
});

describe("Earnings sub-tab: capture-and-stop", () => {
  it(
    "stops (screenshot, nothing recorded) when the Earnings scan reads a non-currency item",
    withRoot(async (root) => {
      const { keeper, ops, clicks } = fakeKeeper(root, {
        strip: {
          top: [
            { label: "Shop", row: "top", point: { x: 428, y: 217 }, width: 90 },
            { label: "Earnings (Remove-only)", row: "top", point: { x: 739, y: 217 }, width: 320 },
          ],
        },
        tabItems: [ringInTab()],
      });
      await expect(keeper.scanEarnings()).rejects.toThrow(/not currency/);
      expect(clicks[0]).toMatch(/Earnings \(Remove-only\)/);
      expect(ops).toContain("capture");
      expect(existsSync(path.join(root, "artifacts", "tab-admin", "earnings-snapshot.json"))).toBe(false);
    }),
  );
});

describe("repriceTabItems: the ledger is written by live passes only", () => {
  const scenario = (dryRun: boolean) => ({
    dryRun,
    assumeCurrentTab: true,
    tabItems: [ringInTab()],
    ocrLines: tooltip(1),
  });

  it(
    "dry-run reports an adoption but does not record it",
    withRoot(async (root) => {
      const { keeper, ledger, ops } = fakeKeeper(root, scenario(true));
      const result = await keeper.repriceTabItems("1Ex", ONE_EX);
      expect(result).toMatchObject({ repriced: 0, skipped: 1, failed: 0 });
      expect(result.report.some((entry) => /NOT recorded \(dry-run/.test(entry))).toBe(true);
      expect(ledger()).toEqual([]);
      expect(ops.filter((op) => ["click", "rightclick", "type", "hotkey", "ctrlclick"].includes(op))).toEqual([]);
    }),
  );

  it(
    "a live pass adopts the at-price item",
    withRoot(async (root) => {
      const { keeper, ledger } = fakeKeeper(root, scenario(false));
      const result = await keeper.repriceTabItems("1Ex", ONE_EX);
      expect(result).toMatchObject({ repriced: 0, skipped: 1, failed: 0 });
      expect(ledger()).toHaveLength(1);
      expect(ledger()[0]).toMatchObject({
        kind: "listed",
        by: "app",
        fingerprint: parseItemText(RING_TEXT).fingerprint,
        price: { amount: 1, currency: "exalted" },
      });
    }),
  );
});

describe("setItemPrice: the right-click is step-gated", () => {
  it(
    "Numpad 9 on the right-click sends nothing and is not retried",
    withRoot(async (root) => {
      const { keeper, ops, plans } = fakeKeeper(root, { dryRun: false, stepMode: true, confirmVerdict: "wrong" });
      const outcome = await keeper.setItemPrice({ x: 100, y: 400 }, ONE_EX, "Doom Loop");
      expect(outcome).toEqual({ ok: false, reason: "right-click-rejected" });
      expect(plans.filter((label) => /right-click/.test(label))).toHaveLength(1);
      expect(ops).not.toContain("rightclick");
      expect(ops).not.toContain("type");
    }),
  );

  it(
    "dry-run never opens the dialog",
    withRoot(async (root) => {
      const { keeper, ops } = fakeKeeper(root, { dryRun: true });
      expect(await keeper.setItemPrice({ x: 100, y: 400 }, ONE_EX, "Doom Loop")).toEqual({ ok: false, reason: "dry-run" });
      expect(ops).toEqual([]);
    }),
  );
});

describe("listBagItems: a failed price dialog", () => {
  const bagRing: IdentifiedItem = { dest: "junk", itemClass: "Rings", text: RING_TEXT, cells: [BAG_CELL] };
  const entry = { item: bagRing, price: ONE_EX, name: "Doom Loop", itemClass: "Rings" };

  it(
    "goes on when the item is still in its bag cell (the game refused), recording nothing",
    withRoot(async (root) => {
      const { keeper, ledger, ops } = fakeKeeper(root, {
        dryRun: false,
        assumeCurrentTab: true,
        bagCells: [[BAG_CELL]],
      });
      const result = await keeper.listBagItems([entry], "1Ex");
      expect(result).toMatchObject({ listed: 0, failed: 1 });
      expect(result.report[0]).toMatch(/price dialog failed .* still in the bag/);
      expect(ops).not.toContain("capture");
      expect(ledger()).toEqual([]);
    }),
  );

  it(
    "stops with a screenshot when the item left the bag without a verified listing",
    withRoot(async (root) => {
      const { keeper, ledger, ops, bursts } = fakeKeeper(root, {
        dryRun: false,
        assumeCurrentTab: true,
        bagCells: [[]],
      });
      await expect(keeper.listBagItems([entry], "1Ex")).rejects.toThrow(/left bag 0,0 but the price dialog failed/);
      expect(bursts).toHaveLength(1);
      expect(ops).toContain("capture");
      expect(ledger()).toEqual([]);
    }),
  );

  it(
    "refuses outright in dry-run",
    withRoot(async (root) => {
      const { keeper, ops } = fakeKeeper(root, { dryRun: true });
      await expect(keeper.listBagItems([entry], "1Ex")).rejects.toThrow(/dry-run/);
      expect(ops).toEqual([]);
    }),
  );
});

describe("applyBucketLadder: the delist gesture is believed only via the bag", () => {
  const BUCKETS = bucketTabs(["1Ex", "5Ex", "10Ex"], table());
  const NOW = Date.parse("2026-09-07T12:00:00.000Z");
  const listing: ActiveListing = {
    fingerprint: parseItemText(RING_TEXT).fingerprint,
    name: "Doom Loop",
    itemClass: "Rings",
    count: 1,
    price: { amount: 10, currency: "exalted", exalted: 10 },
    listedAt: new Date(NOW - 4 * 86_400_000).toISOString(),
    pricedAt: new Date(NOW - 4 * 86_400_000).toISOString(),
    lastEventAt: new Date(NOW - 4 * 86_400_000).toISOString(),
    by: "app",
  };
  const plan = () =>
    planBucketLadder({ listings: [listing], buckets: BUCKETS, config: { ...defaultShopConfig(), shopTab: "1Ex" }, nowMs: NOW });

  it("plans the move under test (10Ex → 5Ex)", () => {
    expect(plan().moves[0]).toMatchObject({ from: { label: "10Ex" }, to: { label: "5Ex" } });
  });

  it(
    "does NOT click the cell when Ctrl+C still reads the item there — nothing moved, stop",
    withRoot(async (root) => {
      const { keeper, clicks, ops, ledger, bursts } = fakeKeeper(root, {
        dryRun: false,
        assumeCurrentTab: true,
        tabItems: [ringInTab()],
        ocrLines: tooltip(10),
        bagCells: [[], []],
        copyAt: (x, y) => (x === RING_CELL.x && y === RING_CELL.y ? RING_TEXT : ""),
      });
      await expect(keeper.applyBucketLadder(plan(), { buckets: BUCKETS })).rejects.toThrow(/still in 10Ex 0,0/);
      expect(bursts.some((label) => /DELIST/.test(label))).toBe(true);
      expect(clicks.filter((why) => /put .* back/.test(why))).toEqual([]);
      expect(ops).toContain("capture");
      expect(ledger()).toEqual([]);
    }),
  );

  it(
    "clicks the cell once to drop a held item only when the cell copies empty, then stops",
    withRoot(async (root) => {
      const { keeper, clicks, ops, ledger } = fakeKeeper(root, {
        dryRun: false,
        assumeCurrentTab: true,
        tabItems: [ringInTab()],
        ocrLines: tooltip(10),
        bagCells: [[], []],
        copyAt: () => "",
      });
      await expect(keeper.applyBucketLadder(plan(), { buckets: BUCKETS })).rejects.toThrow(/cell copies empty/);
      expect(clicks.filter((why) => /put .* back/.test(why))).toHaveLength(1);
      expect(ops).toContain("capture");
      expect(ledger()).toEqual([]);
    }),
  );

  it(
    "skips a listing the game still locks under its price cooldown — no click at all",
    withRoot(async (root) => {
      const { keeper, bursts, clicks } = fakeKeeper(root, {
        dryRun: false,
        assumeCurrentTab: true,
        tabItems: [ringInTab()],
        ocrLines: [
          line("YOU ASSIGNED A PRICE TO THIS ITEM RECENTLY,", 120, 480, 900),
          line("AND CANNOT MODIFY OR REMOVE THE ITEM YET.", 120, 520, 900),
          ...tooltip(10),
        ],
      });
      const result = await keeper.applyBucketLadder(plan(), { buckets: BUCKETS });
      expect(result).toMatchObject({ moved: 0, skipped: 1, failed: 0 });
      expect(result.report[0]).toMatch(/\[cooldown\]/);
      expect(bursts).toEqual([]);
      expect(clicks).toEqual([]);
    }),
  );

  it(
    "refuses outright in dry-run",
    withRoot(async (root) => {
      const { keeper, ops } = fakeKeeper(root, { dryRun: true });
      await expect(keeper.applyBucketLadder(plan(), { buckets: BUCKETS })).rejects.toThrow(/dry-run/);
      expect(ops).toEqual([]);
    }),
  );
});

describe("planBagBuckets: Numpad 0 lands between comps lookups", () => {
  it(
    "checkpoints before every lookup and sends no input",
    withRoot(async (root) => {
      const looked: string[] = [];
      const { keeper, checkpoints, ops } = fakeKeeper(root, {
        bagItems: [
          { dest: "junk", itemClass: "Amulets", text: UNIQUE_TEXT("Astramentis"), cells: [{ row: 0, col: 0, x: 3000, y: 1000 }] },
          { dest: "junk", itemClass: "Amulets", text: UNIQUE_TEXT("Serpent's Egg"), cells: [{ row: 0, col: 1, x: 3070, y: 1000 }] },
        ],
        evaluate: () => ({ tier: "sell", source: "rule", reasons: [], matchedRules: [] }),
        comps: async (text) => {
          looked.push(text);
          return undefined;
        },
      });
      const { plan, held } = await keeper.planBagBuckets(bucketTabs(["1Ex", "5Ex"], table()));
      expect(looked).toHaveLength(2);
      expect(checkpoints.filter((where) => /^pricing /.test(where))).toHaveLength(2);
      expect(plan).toEqual([]);
      expect(held.filter((entry) => /no value estimate/.test(entry))).toHaveLength(2);
      expect(ops.filter((op) => ["click", "ctrlclick", "rightclick", "type", "hotkey", "drag"].includes(op))).toEqual([]);
    }),
  );
});
