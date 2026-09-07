/**
 * Shop keeper: the driving layer of docs/HANDOFF-shop-listings.md.
 *
 * Owns the shop-tab visit (scan → reconcile → plan → apply) and phase 2
 * (bag → appraise → deposit → price → verify). Every decision is pure
 * (src/core/shopListings.ts, shopPricing.ts); this file only moves the
 * mouse, reads Ctrl+C text, and appends the ledger.
 *
 * Invariants inherited from the sorter handoffs:
 *   - Ctrl+C is the only classifier; the Note line is the only price truth.
 *   - Every write is verified: a price write by a Note re-read, a withdraw
 *     by bag growth, a deposit by the bounce check.
 *   - The price dialog is NEW driving: every control is anchored to an
 *     OCR'd label inside the dialog (nothing fixed-coordinate), offsets are
 *     TAUGHT on first use (step mode) and stored in
 *     artifacts/tab-admin/shop-dialog.json.
 *   - Listings whose Note this flow did not write are read-only.
 */
import path from "node:path";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { GearSorter, SourceTab } from "./gearSorter.js";
import { BAG_CELL_CAPACITY, type GridCell, type IdentifiedItem } from "../core/gearSort.js";
import { parseItemText } from "../core/parseItem.js";
import { stackCountOf } from "../core/appraisal.js";
import { screenForLookup, summarizeScreen } from "../core/lookupScreen.js";
import type { SortHarness } from "./sortHarness.js";
import { STRIP_ROWS, pickExact, type StashTabKit, type OcrLine, type StripEntry } from "./stashTabKit.js";
import { copyPoints, findOcrLines, lineCenter, panelsViaOcr } from "./bagKit.js";
import { defaultNameplateCacheFile, findNameplate } from "./nameplateFinder.js";
import type { WinReply } from "./winHost.js";
import {
  bucketFor,
  bucketTabs,
  buildShopSnapshot,
  currencyUnitExalted,
  deriveShopState,
  diffEarnings,
  noteExalted,
  parseListingEvents,
  priceFromTabLabel,
  reconcileShopScan,
  verifySalesWithEarnings,
  type BucketTab,
  type ActiveListing,
  type EarningsDelta,
  type EarningsSnapshot,
  type EarningsStack,
  type ListingEvent,
  type ListingPrice,
  type ShopCell,
  type ShopConfig,
  type ShopSnapshot,
  type ShopSnapshotItem,
  type StackPricingMode,
} from "../core/shopListings.js";
import {
  isPriceRefusal,
  listingGate,
  planBucketLadder,
  planEvictions,
  rankListingCandidates,
  repriceDecision,
  salesStats,
  stackBucketValue,
  suggestListingPrice,
  type BucketLadderMove,
  type BucketLadderPlan,
  type DenominatedPrice,
  type ListingCandidate,
  type PriceRefusal,
  type PriceSuggestion,
} from "../core/shopPricing.js";
import { tradeCurrencyToOrb, type CompsSummary } from "../core/tradeComps.js";
import { HOUSE_LOOKUPS_PER_WINDOW } from "../core/tradePacing.js";
import type { PriceTable } from "../core/priceTable.js";
import type { TierVerdict } from "../core/valueTiers.js";

interface ShopHost {
  send(payload: Record<string, unknown>): Promise<WinReply>;
}

const PARK = { x: 660, y: 1900 } as const;

/**
 * Comps lookups one run may spend: the caller's limit (or the default),
 * never more than trade2's house rules allow in a five-minute window
 * (core/tradePacing.ts) — past that the pacer would stall the run for
 * minutes mid-bag, and the remaining items list at the floor anyway.
 */
function compsBudgetFor(limit: number | undefined, fallback: number): number {
  const wanted = typeof limit === "number" && Number.isFinite(limit) ? limit : fallback;
  return Math.max(0, Math.min(Math.floor(wanted), HOUSE_LOOKUPS_PER_WINDOW));
}

/** Currency by Ctrl+C ground truth: the class line, else the rarity line. */
function isCurrencyItem(item: Pick<IdentifiedItem, "text" | "itemClass">): boolean {
  if (/currency/i.test(item.itemClass ?? "")) return true;
  const parsed = parseItemText(item.text);
  return /currency/i.test(parsed.itemClass) || /currency/i.test(parsed.rarity);
}

/** The item's display name: the first copy line after the class/rarity header. */
function itemNameOf(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line && !/^(Item Class|Rarity):/i.test(line) && line !== "--------") ?? "item"
  );
}

/** A bag item the plan sends to the vendor instead of the shop. */
export interface VendorEntry {
  item: IdentifiedItem;
  name: string;
  itemClass: string;
  reason: string;
}

/** A currency stack's pricing facts, carried from the plan to the listing gate. */
export interface StackListingInfo {
  count: number;
  mode: StackPricingMode;
  unitValue: number;
  /** "STACK ×20 (whole)" — the plan-line marker. */
  label: string;
}

/** One bag item routed to a price-bucket tab. */
export interface BucketPlanEntry {
  item: IdentifiedItem;
  name: string;
  itemClass: string;
  bucket: BucketTab;
  /** The value estimate the bucket was chosen from, in exalted. */
  estimateExalted: number;
  /** Where the estimate came from (price table, comps …). */
  basis: string;
  /** Set for currency stacks: how the estimate was derived (stack pricing flag). */
  stack?: StackListingInfo;
}

/** One bag item to list in a merchant tab at a price. */
export interface ListBagEntry {
  item: IdentifiedItem;
  price: DenominatedPrice;
  name: string;
  itemClass: string;
  stack?: StackListingInfo;
}

// ---------------------------------------------------------------------------
// Plan model (what the CLI prints and the app displays)
// ---------------------------------------------------------------------------

export interface ShopAction {
  kind: "reprice" | "delist" | "price-unpriced";
  fingerprint: string;
  name: string;
  itemClass: string;
  cell?: ShopCell;
  from?: ListingPrice;
  to?: DenominatedPrice;
  badges: string[];
  reasons: string[];
}

export interface ShopHold {
  fingerprint: string;
  name: string;
  badges: string[];
  reasons: string[];
}

export interface ShopPlan {
  at: string;
  tab: string;
  actions: ShopAction[];
  holds: ShopHold[];
  report: string[];
}

export interface PriceWriteOutcome {
  ok: boolean;
  reason?: string;
  /** The tooltip's Asking Price line read back after the write. */
  readBack?: string;
}

// ---------------------------------------------------------------------------
// Price dialog calibration (taught anchors)
// ---------------------------------------------------------------------------

interface Offset {
  dx: number;
  dy: number;
}

/**
 * Where the SET ITEM PRICE dialog's controls are, relative to OCR'd text
 * INSIDE the dialog. Two anchors, because the dialog's height follows the
 * item's sprite (a bow's preview sits ~200px taller than a pair of gloves',
 * user demonstration 2026-09-02):
 *   - the TITLE proves the dialog is open and anchors the close cross;
 *   - the LIST ITEM button anchors the price row (amount field, currency
 *     selector) and the currency options that drop down beneath it.
 */
interface ShopDialogCalibration {
  version: 2;
  taughtAt: string;
  /** Regex source that matched the title line when taught/seeded. */
  titlePattern: string;
  /** Regex source that matched the row anchor (LIST ITEM) when taught/seeded. */
  rowPattern: string;
  /** From the ROW anchor's centre; confirm is the LIST ITEM button itself. */
  offsets: {
    amount: Offset;
    confirm: Offset;
    currencyOpen?: Offset;
  };
  /** From the TITLE line's centre. */
  closeFromTitle?: Offset;
  /** Per-currency option points inside the opened selector, from the row centre. */
  currencyOptions: Record<string, Offset>;
}

/** Title lines proving the dialog is open — the real title first, OCR fallbacks after. */
const DIALOG_TITLE_ANCHORS: RegExp[] = [
  /set\s*item\s*price/i,
  /select a buyout price/i,
  /\bitem\s*price\b/i,
];

/** The price row's anchor: the LIST ITEM button's own label. */
const DIALOG_ROW_ANCHORS: RegExp[] = [/list\s*item/i, /^\s*list\s*$/i];

/** Offsets are measured from a line's CENTRE — stable across the OCR's
 * varying left-edge padding, and what the seeded calibration uses. */
function anchorCentre(line: OcrLine): { x: number; y: number } {
  return { x: Math.round(line.x + line.w / 2), y: Math.round(line.y + line.h / 2) };
}

function findLine(
  lines: readonly OcrLine[],
  patterns: readonly RegExp[],
): { line: OcrLine; pattern: RegExp } | undefined {
  for (const pattern of patterns) {
    const line = lines.find((entry) => pattern.test(entry.text));
    if (line) return { line, pattern };
  }
  return undefined;
}

/**
 * The currency a dialog/tooltip label names: "Divine Orb" → divine, "Orb of
 * Alchemy" → alchemy, "Greater Exalted Orb" → greater-exalted (a currency we
 * never price in — the selector must be driven to one of ours).
 */
const ORB_WORDS =
  "exalted|divine|chaos|regal|alchemy|annulment|transmutation|augmentation|vaal|fracturing|mirror";
/** "Greater Exalted Orb", "Orb of Alchemy", "5x Divine Orb", "AD EXALTED ORB . BENCH" … */
const CURRENCY_PHRASE = new RegExp(
  String.raw`(?:\b(greater|perfect)\s+)?\b(${ORB_WORDS})\s+orbs?\b|\borbs?\s+of\s+(${ORB_WORDS})\b`,
  "i",
);

export function currencyFromLabel(text: string): string | undefined {
  // The known phrase wins wherever it sits — OCR debris before or after it
  // ("Ixt AD EXALTED ORB", "EXALTED ORB . BENCH") must not become a
  // currency of its own.
  const phrase = CURRENCY_PHRASE.exec(text);
  if (phrase) {
    const grade = phrase[1]?.toLowerCase();
    const word = (phrase[2] ?? phrase[3])!.toLowerCase();
    const base = tradeCurrencyToOrb(word) ?? word;
    return grade ? `${grade}-${base}` : base;
  }
  const cleaned = text
    .toLowerCase()
    .replace(/^\s*\d+(?:[.,]\d+)?\s*[x×]?\s*/, "")
    .replace(/\borb of\b/g, "")
    .replace(/\borbs?\b/g, "")
    .replace(/[^a-z ]+/g, " ")
    .trim()
    .replace(/\s+/g, "-");
  if (!cleaned) return undefined;
  return tradeCurrencyToOrb(cleaned) ?? cleaned;
}

export interface AskingPrice {
  amount: number;
  currency: string;
  raw: string;
  /** The amount glyph did not OCR ("1x" is tiny); 1 is assumed and flagged. */
  amountAssumed?: boolean;
  /** The tooltip carried the "cannot modify or remove the item yet" cooldown line. */
  locked?: boolean;
}

/** OCR sometimes decorates letters ("PRICÉ"): compare without diacritics. */
function foldDiacritics(text: string): string {
  // Combining marks are U+0300..U+036F after NFD decomposition.
  return Array.from(text.normalize("NFD"))
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code < 0x300 || code > 0x36f;
    })
    .join("");
}

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_value, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const above = row[j]!;
      row[j] = Math.min(above + 1, row[j - 1]! + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[b.length]!;
}

/**
 * The "Asking Price:" label, including the garbles OCR produced live on
 * 2026-09-03 ("ASKING PRICÉ:", "AsigNGPRlGE:"): letters only, l/| folded to
 * I, within three edits of ASKINGPRICE.
 */
export function isAskingPriceLabel(text: string): boolean {
  const folded = foldDiacritics(text);
  if (/asking\s*price/i.test(folded)) return true;
  const letters = folded.replace(/[^a-z]/gi, "").toUpperCase().replace(/[L|]/g, "I");
  if (letters.length < 9 || letters.length > 14) return false;
  return editDistance(letters, "ASKINGPRICE") <= 3;
}

/**
 * The cooldown lines under a freshly priced item ("You assigned a price to
 * this item recently, and cannot modify or remove the item yet"), as OCR
 * renders them ("A RICE fro THIS ITEM", "M DIF O'OREMOVE").
 */
export function isCooldownLine(text: string): boolean {
  return /assigned\s+a\s+p?rice|cannot\s+m\S*\s*\S*\s*remove|\bitem\s+yet\b/i.test(text);
}

/**
 * A listed item's price from its hover tooltip: an "Asking Price:" label
 * followed by "Nx <Currency>" (sometimes OCR'd onto the same line). This is
 * the merchant's price ground truth — Ctrl+C on a listed item carries no
 * price at all (user demonstration, 2026-09-02).
 */
export function parseAskingPrice(lines: readonly OcrLine[]): AskingPrice | undefined {
  const label = lines.find((line) => isAskingPriceLabel(line.text));
  const cooldownLines = lines.filter((line) => isCooldownLine(line.text));
  // No readable label: the cooldown lines sit directly above the price and
  // prove one exists (live 2026-09-03: labels garbled past recognition or
  // cut by the crop) — anchor on the lowest of them instead.
  const anchor = label ?? [...cooldownLines].sort((a, b) => b.y - a.y)[0];
  if (!anchor) return undefined;
  const inline = label
    ? /(?:asking\s*price|pr[il][cg]e)\W{0,2}\s*(\d.*)$/i.exec(foldDiacritics(label.text))?.[1]
    : undefined;
  const labelCentre = anchorCentre(anchor);
  // The tooltip's shortcut hints (ALT Inspect · SHIFT Compare · SHIFT+ALT
  // Price Check) float beside the price and OCR into the same band — never
  // part of the value. They are STRIPPED, not used to drop the line: live
  // on 2026-09-03 OCR glued "COMPARE" onto the value row and the whole
  // price vanished with it.
  const HINT_WORDS = /price\s*check|inspect|compare|\b(?:alt|shift)\b|\+/gi;
  const stripHints = (text: string): string => text.replace(HINT_WORDS, " ").replace(/\s+/g, " ").trim();
  const below = lines
    .filter(
      (line) =>
        line !== anchor &&
        line.y > anchor.y &&
        line.y - anchor.y < (label ? 140 : 160) &&
        Math.abs(anchorCentre(line).x - labelCentre.x) < 500 &&
        stripHints(line.text).length > 0 &&
        !isCooldownLine(line.text) &&
        !isAskingPriceLabel(line.text),
    )
    // Same visual row = same 20px band; then left to right ("lxv" before "EXALTED ORB").
    .sort((a, b) => Math.round(a.y / 20) - Math.round(b.y / 20) || a.x - b.x)
    .map((line) => stripHints(line.text));
  const rawJoined = (inline ?? below.slice(0, 2).join(" "))
    .replace(/\s+/g, " ")
    .replace(/^[^0-9a-z]+/i, "") // stray quote/tick debris before the amount
    .replace(/\b[0OP]RB\b/gi, "ORB") // "PRB"/"0RB" misreads of ORB
    .trim();
  const locked = cooldownLines.length > 0;
  // Live OCR variants (2026-09-02): "18X DIVINE ORB", "18X - DIVINE ORB"
  // (the currency icon reads as a dash), "ASKING PRICE?" for the colon,
  // "lxv EXALTED ORB" (a single "1x" reads as l/I plus icon debris), and
  // "EXALTED ORB" alone when the tiny "1x" glyph is dropped altogether.
  // The amount token — digits (OCR confusables folded) followed by the "x"
  // glyph, possibly with debris ("5Xz", "lxv") — can land BEFORE or AFTER
  // the currency words depending on how the OCR split the row.
  const fold = (digits: string) => digits.replace(/[lI|]/g, "1").replace(/O/g, "0");
  const xToken = /(?:^|[\s,;:.'-])([0-9lIO|]{1,4})\s*[xX×]\S{0,2}(?=\s|$)/.exec(rawJoined);
  const bareLead = xToken ? undefined : /^([0-9lIO|]{1,4})(?=\s|$)/.exec(rawJoined);
  let amount: number | undefined;
  let rest = rawJoined;
  // A group with no real digit is the tiny "1x" glyph plus icon debris,
  // never a multi-digit amount: "lxv"/"Ixt" before an x, or a bare "IO"
  // off a 2x-zoomed icon (live 2026-09-03 that folded to 10x and triggered
  // a pointless reprice of a 1 ex item). Leave it unread so the 1x
  // assumption below applies, flagged.
  if (xToken) {
    if (/[0-9]/.test(xToken[1]!)) amount = Number(fold(xToken[1]!));
    rest = rawJoined.replace(xToken[0], " ");
  } else if (bareLead && /[0-9]/.test(bareLead[1]!)) {
    amount = Number(fold(bareLead[1]!));
    rest = rawJoined.slice(bareLead[0].length);
  }
  // World text ("REFORGING BENCH") OCRs onto the value line after the
  // currency — cut the currency part at its ORB. The amount token, which can
  // also trail the currency ("EXALTED ORB 5Xz"), was taken out above.
  const currency = currencyFromLabel(
    rest.replace(/^(.*?\bORB\b).*$/i, "$1").replace(/[^a-z ]/gi, " "),
  );
  if (!currency || !/\borb\b/i.test(rawJoined)) return undefined;
  if (amount === undefined || !Number.isFinite(amount) || amount <= 0) {
    // Currency-only line: multi-digit amounts always OCR, so a dropped
    // amount is a single "1x" in practice — assumed and FLAGGED, never silent.
    return {
      amount: 1,
      currency,
      raw: `${rawJoined} (amount unread, assumed 1x)`,
      amountAssumed: true,
      ...(locked ? { locked } : {}),
    };
  }
  return { amount, currency, raw: rawJoined, ...(locked ? { locked } : {}) };
}

/**
 * Does a tooltip read match the intended price? An unreadable amount with
 * the right currency counts: the read cannot tell 1x from 5x, the item was
 * priced at this bucket, and a reprice could be verified no better — so it
 * must never trigger a reprice loop.
 */
function priceMatches(read: AskingPrice, price: { amount: number; currency: string }): boolean {
  if (read.currency !== price.currency) return false;
  return read.amountAssumed ? true : read.amount === price.amount;
}

export interface ShopKeeperOptions {
  root: string;
  config: ShopConfig;
  dryRun: boolean;
  stepMode: boolean;
  priceTable?: PriceTable;
  /**
   * The LIVE price table when a feed refresh can replace it mid-run: the
   * merge builds a new table object, so a keeper holding the pre-refresh
   * one valued every divine bucket at a stale rate while comps arrived at
   * the live one. Read on every use; `priceTable` is the fallback.
   */
  getPriceTable?: () => PriceTable;
  /**
   * Rate-limited comps provider (the caller owns pacing and caching).
   * "rate-limited" ends comps lookups for the rest of the run — the
   * remaining items are held with that reason instead of stalling a
   * minute each (2026-09-03).
   */
  comps?: (itemText: string) => Promise<CompsSummary | undefined | "rate-limited">;
  /** Triage evaluator for phase 2 (rules + price table + appraisal). */
  evaluate?: (itemText: string) => TierVerdict;
  log?: (line: string) => void;
  now?: () => Date;
  /**
   * The user has the wanted merchant tab on screen already: never touch the
   * tab strip (no OCR match, no unmask hop, no click prompt). The scan's
   * label is still the one given, for the ledger and phantom store.
   */
  assumeCurrentTab?: boolean;
  /**
   * Verify bag listings with the OLD whole-tab rescan (--full-verify)
   * instead of the targeted landing-cell diff. The targeted path falls back
   * to it per item on any ambiguity anyway.
   */
  fullVerify?: boolean;
}

export class ShopKeeper {
  private readonly log: (line: string) => void;
  /** The first live STACK listing of a run is step-gated once (stack pricing is unverified). */
  private stackGateShown = false;

  constructor(
    private readonly host: ShopHost,
    private readonly harness: SortHarness,
    private readonly kit: StashTabKit,
    private readonly sorter: GearSorter,
    private readonly options: ShopKeeperOptions,
  ) {
    this.log = options.log ?? ((line) => console.log(line));
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  /** The price table as of NOW (a feed refresh may have replaced it). */
  private get table(): PriceTable | undefined {
    return this.options.getPriceTable?.() ?? this.options.priceTable;
  }

  private get outDir(): string {
    return path.join(this.options.root, "artifacts", "tab-admin");
  }

  private get ledgerFile(): string {
    return path.join(this.outDir, "listings.jsonl");
  }

  private get dialogFile(): string {
    return path.join(this.outDir, "shop-dialog.json");
  }

  private get earningsFile(): string {
    return path.join(this.outDir, "earnings-snapshot.json");
  }

  /**
   * The one merchant tab this feature may touch, as an index source. The
   * Merchant panel's grid uses the FOLDER-row geometry (12x12, same bounds
   * as a folder stash tab) and its navigation is the panel's own strip —
   * never stash navigation, so scanTab runs with navigate:false.
   */
  source(): SourceTab {
    // shop: true pins the merchant grid to 12x12 (a crowded tab read as
    // 24x24 live on 2026-09-03) and keeps cleanTab refusing it.
    return { label: this.options.config.shopTab, occurrence: 0, shop: true };
  }

  /**
   * The Merchant panel's "Earnings (Remove-only)" sub-tab as an index
   * source. It is a SHOP source scanned with navigate:false — the strip
   * click is the keeper's own — so the stash Remove-only refusal (a gotoTab
   * rule for stash sources) is never consulted; cleanTab still refuses it.
   */
  earningsSource(): SourceTab {
    return { label: "Earnings", occurrence: 0, shop: true };
  }

  /**
   * Save a screenshot (BMP + PNG preview) under artifacts/tab-admin/debug
   * and hand back the error that aborts the run — callers `throw await` it.
   * The capture-and-stop rule for every unexpected UI state on an
   * unverified gesture: never guess at a recovery click.
   */
  private async captureAndStop(tag: string, why: string): Promise<Error> {
    const dir = path.join(this.outDir, "debug");
    mkdirSync(dir, { recursive: true });
    const stamp = Date.now();
    const bmp = path.join(dir, `shop-${tag}-${stamp}.bmp`);
    const png = path.join(dir, `shop-${tag}-${stamp}.png`);
    const captured = await this.host
      .send({ op: "capture", path: bmp, previewPath: png })
      .catch(() => ({ ok: false }) as WinReply);
    await this.park();
    const where = captured.ok ? png : "(capture failed)";
    this.log(`  ! STOP: ${why} — screenshot ${where}`);
    return new Error(`${tag}: ${why} (capture ${where})`);
  }

  // -------------------------------------------------------------------------
  // Merchant panel navigation (Ange → Manage Shop → tab)
  // -------------------------------------------------------------------------

  /** The inventory panel's title band (the bag is only readable while it shows). */
  async inventoryOpen(): Promise<boolean> {
    const band = await this.host.send({ op: "ocr", left: 2900, top: 100, width: 800, height: 110 });
    if (/inventory/i.test(String(band.text ?? ""))) return true;
    const lines = (Array.isArray(band.lines) ? band.lines : []) as OcrLine[];
    return lines.some((line) => /inventory/i.test(line.text));
  }

  /**
   * Refuse to read a grid whose panel is not on screen: a scan of the
   * hideout floor "finds" a full grid and hovers across the world for
   * minutes (2026-09-03). Every scan and bag read goes through here.
   */
  private async requirePanel(panel: "merchant" | "inventory"): Promise<void> {
    const open = panel === "merchant" ? await this.merchantOpen() : await this.inventoryOpen();
    if (!open) {
      throw new Error(
        panel === "merchant"
          ? "merchant-panel-not-open — open Ange's Manage Shop first (or let the run open it)"
          : "inventory-not-open — the bag is only readable while the inventory panel shows",
      );
    }
  }

  /** OCR the panel title band: the Merchant panel sits where the stash does. */
  async merchantOpen(): Promise<boolean> {
    const band = await this.host.send({ op: "ocr", left: 450, top: 100, width: 700, height: 110 });
    if (/merchant/i.test(String(band.text ?? ""))) return true;
    const lines = (Array.isArray(band.lines) ? band.lines : []) as OcrLine[];
    return lines.some((line) => /merchant/i.test(line.text));
  }

  /**
   * Open Ange's Merchant panel: click her nameplate, then the "Manage Shop"
   * row of her dialogue — both located by OCR (nameplates move with the
   * camera, the dialogue is world-anchored). Verified by the panel title.
   */
  async ensureMerchantOpen(): Promise<boolean> {
    if (await this.merchantOpen()) return true;
    // The stash panel sits where the Merchant does: Ange cannot be clicked
    // through it, and a stray "Ange" OCR hit behind it would click into the
    // panel. The Review source closes the stash itself (closeStashPanel);
    // anything else must close it by hand.
    if ((await panelsViaOcr(this.host)).stash) {
      this.log("  ! the stash panel is open — close it before the Merchant can be opened");
      return false;
    }
    await this.host.send({ op: "focus" });
    await this.harness.sleep(200, false);
    await this.park();
    let lines = await this.kit.settledOcr();
    // Her dialogue may already be up (an interrupted run leaves it open).
    let manage = lines.find((line) => /manage\s*shop/i.test(line.text));
    if (!manage) {
      const plate = lines.find((line) => /^\s*ange\s*$/i.test(line.text));
      if (!plate) {
        this.log("  ! Ange's nameplate is not on screen — stand near her in the hideout with no panel open");
        return false;
      }
      const plateCentre = anchorCentre(plate);
      await this.clickStep(plateCentre.x, plateCentre.y, "talk to Ange");
      await this.park();
      await this.harness.sleep(900, false);
      lines = await this.kit.settledOcr();
      manage = lines.find((line) => /manage\s*shop/i.test(line.text));
    }
    if (!manage) {
      if (await this.merchantOpen()) return true; // the correction click went all the way
      this.log("  ! Ange's dialogue did not show \"Manage Shop\" — OCR saw:");
      for (const line of lines.slice(0, 16)) this.log(`      (${line.x},${line.y}) "${line.text}"`);
      return false;
    }
    const manageCentre = anchorCentre(manage);
    await this.clickStep(manageCentre.x, manageCentre.y, "Ange: Manage Shop");
    await this.park();
    await this.harness.sleep(900, false);
    return this.merchantOpen();
  }

  /**
   * Select a merchant tab by its strip label (exact fold-equality only).
   * Single-digit labels often defeat OCR; when the label cannot be read the
   * user is asked to click it themselves and confirm with Numpad 8.
   */
  /**
   * The merchant strip's headers at 2x: short labels like "1Ex" never OCR at
   * native size (the full-screen read drops them), a zoomed crop of the
   * folder-row band reads them. Entries mirror StashTabKit.stripEntries.
   */
  private async readStripZoomed(): Promise<StripEntry[]> {
    await this.park();
    const band = STRIP_ROWS.folder;
    const reply = await this.host.send({
      op: "ocr",
      left: 20,
      top: band.min - 8,
      width: 1320,
      height: band.max - band.min + 16,
      scale: 2,
    });
    const lines = (Array.isArray(reply.lines) ? reply.lines : []) as OcrLine[];
    return lines
      .filter((line) => line.x < 1340)
      .sort((a, b) => a.x - b.x)
      .map((line) => ({
        label: line.text.trim(),
        row: "folder" as const,
        point: { x: Math.round(line.x + line.w / 2), y: Math.round(line.y + line.h / 2) },
        width: line.w,
      }));
  }

  /**
   * The bucket tabs currently visible on the merchant strip: the native
   * read plus the 2x read (short labels like "1Ex" only read zoomed),
   * merged by price. The ACTIVE tab's label is unreadable either way —
   * pass known buckets explicitly when it matters.
   */
  async readBucketTabs(): Promise<BucketTab[]> {
    await this.requirePanel("merchant");
    const strip = await this.kit.readStrip();
    const zoomed = await this.readStripZoomed();
    const labels = [...strip.folder, ...strip.top, ...zoomed].map((entry) => entry.label);
    const buckets = bucketTabs(labels, this.table);
    const seen = new Set<string>();
    return buckets.filter((bucket) => {
      const key = `${bucket.amount}:${bucket.currency}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  async selectMerchantTab(label: string): Promise<boolean> {
    await this.requirePanel("merchant");
    if (this.options.assumeCurrentTab) {
      this.log(`  · taking the current merchant tab as "${label}" (--current) — strip untouched`);
      return true;
    }
    const strip = await this.kit.readStrip();
    let entry = pickExact(strip.folder, label) ?? pickExact(strip.top, label);
    if (!entry) {
      const zoomed = await this.readStripZoomed();
      entry = pickExact(zoomed, label);
      if (entry) this.log(`  · merchant tab "${label}" read at 2x zoom (${zoomed.map((e) => e.label).join(" | ")})`);
    }
    if (entry) {
      await this.clickStep(entry.point.x, entry.point.y, `merchant tab "${label}"`);
      await this.park();
      await this.harness.sleep(700, false);
      return true;
    }
    // The ACTIVE tab's highlight defeats OCR (strip and list alike). If any
    // other bucket-looking header is readable, hop to it so the wanted tab
    // becomes readable, then click the wanted one — the sorter's unmask hop.
    const other = strip.folder.find(
      (entry) => entry.label.trim().length >= 2 && priceFromTabLabel(entry.label) !== undefined,
    );
    if (other) {
      this.log(`  · merchant tab "${label}" unreadable (probably active) — hopping via "${other.label}" to unmask it`);
      await this.clickStep(other.point.x, other.point.y, `unmask hop: merchant tab "${other.label}"`);
      await this.park();
      await this.harness.sleep(700, false);
      const again = await this.kit.readStrip();
      const found = pickExact(again.folder, label) ?? pickExact(again.top, label);
      if (found) {
        await this.clickStep(found.point.x, found.point.y, `merchant tab "${label}"`);
        await this.park();
        await this.harness.sleep(700, false);
        return true;
      }
    }
    this.log(
      `  · merchant tab "${label}" not readable in the strip (${strip.folder.map((e) => e.label).join(" | ") || "no labels"}) — asking you to click it`,
    );
    const verdict = await this.harness.confirmPlan(
      [],
      `click merchant tab "${label}" yourself, then Numpad 8 (9 = abort)`,
    );
    return verdict === "good";
  }

  // -------------------------------------------------------------------------
  // Earnings (Remove-only) sub-tab: verified sales
  // -------------------------------------------------------------------------

  /**
   * The Merchant panel's two SUB-tabs — "Shop" and "Earnings (Remove-only)"
   * — sit in the TOP strip band (measured (428,217) / (739,217), 2026-09-02).
   * Find one by its readable label (native strip read, then 2x). Returns the
   * strip entry or undefined; NEVER prompts, so an unattended record run
   * falls back to the heuristic instead of waiting on a keypress.
   */
  private async findMerchantSubTab(name: "Shop" | "Earnings"): Promise<StripEntry | undefined> {
    const strip = await this.kit.readStrip();
    // pickExact folds word by word, so "Earnings (Remove-only)" answers to
    // "Earnings" — the "(Remove-only)" suffix is the panel's own label and
    // must never trip the stash refusal (a different panel entirely).
    const entry = pickExact(strip.top, name) ?? pickExact(strip.folder, name);
    if (entry) return entry;
    const zoomedTop = await this.readSubTabBandZoomed();
    return pickExact(zoomedTop, name);
  }

  /** The sub-tab band at 2x, mirroring readStripZoomed for the TOP row. */
  private async readSubTabBandZoomed(): Promise<StripEntry[]> {
    await this.park();
    const band = STRIP_ROWS.top;
    const reply = await this.host.send({
      op: "ocr",
      left: 20,
      top: band.min - 8,
      width: 1320,
      height: band.max - band.min + 16,
      scale: 2,
    });
    const lines = (Array.isArray(reply.lines) ? reply.lines : []) as OcrLine[];
    return lines
      .filter((line) => line.x < 1340)
      .sort((a, b) => a.x - b.x)
      .map((line) => ({
        label: line.text.trim(),
        row: "top" as const,
        point: { x: Math.round(line.x + line.w / 2), y: Math.round(line.y + line.h / 2) },
        width: line.w,
      }));
  }

  loadEarningsSnapshot(): EarningsSnapshot | undefined {
    try {
      if (!existsSync(this.earningsFile)) return undefined;
      const parsed = JSON.parse(readFileSync(this.earningsFile, "utf8")) as EarningsSnapshot;
      return parsed && typeof parsed.at === "string" && Array.isArray(parsed.stacks) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  /** Persist the Earnings baseline the next diff runs against. */
  saveEarningsSnapshot(snapshot: EarningsSnapshot): void {
    mkdirSync(this.outDir, { recursive: true });
    writeFileSync(this.earningsFile, JSON.stringify(snapshot, null, 2));
  }

  /** A scanned Earnings item as a currency stack (Ctrl+C ground truth). */
  private stackOf(item: IdentifiedItem): EarningsStack {
    const parsed = parseItemText(item.text);
    const name = parsed.name || parsed.baseType || itemNameOf(item.text);
    const count = stackCountOf(parsed) ?? 1;
    const unit = currencyUnitExalted(name, this.table);
    return {
      name,
      count,
      ...(unit !== undefined ? { exalted: Math.round(unit * count * 100) / 100 } : {}),
    };
  }

  /**
   * Scan the Earnings (Remove-only) sub-tab: select it by its strip label,
   * index the 12x12 grid by Ctrl+C (currency stacks; the stack size comes
   * from each item's properties), diff against the saved baseline, and
   * return to the Shop sub-tab so the bucket strip is on screen again.
   * `found: false` = the sub-tab could not be read — the caller keeps the
   * gone-from-tab heuristic and says so. Nothing is persisted here.
   */
  async scanEarnings(): Promise<{
    found: boolean;
    snapshot?: EarningsSnapshot;
    previous?: EarningsSnapshot;
    delta?: EarningsDelta;
    items: IdentifiedItem[];
    report: string[];
  }> {
    const report: string[] = [];
    if (this.options.assumeCurrentTab) {
      report.push("--current: the Earnings sub-tab is not selectable — sold detection stays heuristic");
      return { found: false, items: [], report };
    }
    if (!(await this.ensureMerchantOpen())) throw new Error("merchant-panel-not-open");
    const earnings = await this.findMerchantSubTab("Earnings");
    if (!earnings) {
      report.push("Earnings sub-tab not readable on the Merchant strip — sold detection stays heuristic");
      return { found: false, items: [], report };
    }
    await this.clickStep(earnings.point.x, earnings.point.y, 'merchant sub-tab "Earnings (Remove-only)"');
    await this.park();
    await this.harness.sleep(700, false);
    await this.requirePanel("merchant");
    const scan = await this.sorter.scanTab(this.earningsSource(), { navigate: false });
    if (!scan.ok) throw new Error(`earnings-scan-failed:${scan.reason}`);
    // Sale proceeds are currency by construction (the price dialog offers
    // nothing else). A non-currency read means the sub-tab click did not
    // land and this is some bucket tab: a snapshot of it would become a
    // false baseline and every later delta a false "verified" sale.
    const foreign = scan.modelItems.find((item) => !isCurrencyItem(item));
    if (foreign) {
      throw await this.captureAndStop(
        "earnings-scan",
        `the Earnings scan read "${itemNameOf(foreign.text)}" (${foreign.itemClass ?? parseItemText(foreign.text).itemClass}) — not currency, so the sub-tab click did not land; nothing recorded`,
      );
    }
    const stacks = scan.modelItems.map((item) => this.stackOf(item));
    const snapshot: EarningsSnapshot = { at: this.now().toISOString(), stacks };
    const previous = this.loadEarningsSnapshot();
    const delta = diffEarnings(previous, snapshot, this.table);
    report.push(
      `Earnings: ${stacks.length} stack(s)` +
        (stacks.length > 0
          ? ` — ${stacks.map((stack) => `${stack.count}x ${stack.name}${stack.exalted !== undefined ? ` (≈${stack.exalted} ex)` : ""}`).join(", ")}`
          : "") +
        (scan.unread.length > 0 ? `; ${scan.unread.length} unread cell(s)` : ""),
    );
    report.push(
      previous
        ? `Earnings since ${previous.at}: ${delta.perCurrency
            .filter((entry) => entry.delta !== 0)
            .map((entry) => `${entry.delta > 0 ? "+" : ""}${entry.delta} ${entry.name}`)
            .join(", ") || "no change"} → ≈${delta.totalExalted} ex in proceeds`
        : "Earnings: no previous snapshot — this scan becomes the baseline (recorded with --record)",
    );
    // Back to the Shop sub-tab: the bucket strip only shows there. If its
    // label does not read, the next selectMerchantTab prompts as usual.
    const shop = await this.findMerchantSubTab("Shop");
    if (shop) {
      await this.clickStep(shop.point.x, shop.point.y, 'merchant sub-tab "Shop"');
      await this.park();
      await this.harness.sleep(700, false);
    } else {
      this.log('  ! "Shop" sub-tab not readable after the Earnings scan — the next tab selection may prompt');
    }
    return { found: true, snapshot, previous, delta, items: scan.modelItems, report };
  }

  /**
   * Move Earnings stacks to the bag: a plain LEFT-CLICK on an Earnings item
   * moves it to the bag (user demonstration 2026-09-02 — the only gesture
   * seen there). Each click is verified by a bag Ctrl+C read of the new
   * cell naming the same currency; anything else captures a screenshot and
   * stops (a stack could be on the cursor — never guess a second click).
   * Returns the stacks that verifiably reached the bag.
   */
  async collectEarnings(items: readonly IdentifiedItem[]): Promise<{ collected: EarningsStack[]; report: string[] }> {
    if (this.options.dryRun) throw new Error("shop-apply-refused-in-dry-run");
    const report: string[] = [];
    const collected: EarningsStack[] = [];
    if (items.length === 0) return { collected, report };
    if (!(await this.ensureMerchantOpen())) throw new Error("merchant-panel-not-open");
    const earnings = await this.findMerchantSubTab("Earnings");
    if (!earnings) throw new Error("earnings-tab-not-readable — cannot collect");
    await this.clickStep(earnings.point.x, earnings.point.y, 'merchant sub-tab "Earnings (Remove-only)"');
    await this.park();
    await this.harness.sleep(700, false);
    await this.requirePanel("merchant");
    await this.requirePanel("inventory");
    for (const [index, item] of items.entries()) {
      const stack = this.stackOf(item);
      const cell = item.cells[0]!;
      const before = await this.sorter.bagCellsNow();
      if (before.length >= BAG_CELL_CAPACITY) {
        report.push(`${stack.count}x ${stack.name}: bag full — left in Earnings`);
        continue;
      }
      await this.clickStep(cell.x, cell.y, `collect ${index + 1}/${items.length}: ${stack.count}x ${stack.name} → bag`);
      await this.park();
      await this.harness.sleep(700, false);
      const after = await this.sorter.bagCellsNow();
      const known = new Set(before.map((entry) => `${entry.row},${entry.col}`));
      const landed = after.filter((entry) => !known.has(`${entry.row},${entry.col}`));
      if (landed.length === 0) {
        throw await this.captureAndStop(
          "collect-earnings",
          `the bag did not grow after clicking ${stack.name} — the stack may be on the cursor; check the game before rerunning`,
        );
      }
      const text = await this.sorter.copyAt(landed[0]!.x, landed[0]!.y);
      const arrived = text ? this.stackOf({ ...item, text }) : undefined;
      if (!arrived || arrived.name !== stack.name) {
        throw await this.captureAndStop(
          "collect-earnings",
          `bag cell ${landed[0]!.row},${landed[0]!.col} reads ${arrived ? `"${arrived.name}"` : "nothing"} after collecting ${stack.name}`,
        );
      }
      collected.push(arrived);
      report.push(`${arrived.count}x ${arrived.name}: collected to bag ${landed[0]!.row},${landed[0]!.col} (verified by Ctrl+C)`);
    }
    const shop = await this.findMerchantSubTab("Shop");
    if (shop) {
      await this.clickStep(shop.point.x, shop.point.y, 'merchant sub-tab "Shop"');
      await this.park();
      await this.harness.sleep(700, false);
    }
    return { collected, report };
  }

  // -------------------------------------------------------------------------
  // Ledger
  // -------------------------------------------------------------------------

  loadLedger(): ListingEvent[] {
    if (!existsSync(this.ledgerFile)) return [];
    try {
      return parseListingEvents(readFileSync(this.ledgerFile, "utf8"));
    } catch {
      return [];
    }
  }

  appendEvents(events: readonly ListingEvent[]): void {
    if (events.length === 0) return;
    mkdirSync(this.outDir, { recursive: true });
    for (const event of events) {
      appendFileSync(this.ledgerFile, `${JSON.stringify(event)}\n`);
    }
  }

  // -------------------------------------------------------------------------
  // Phase 1: scan → reconcile → plan
  // -------------------------------------------------------------------------

  /**
   * Index the shop tab by Ctrl+C ground truth. Returns the snapshot plus the
   * raw identified items (whose cells carry screen x/y for later actions).
   */
  async scan(): Promise<{ snapshot: ShopSnapshot; items: IdentifiedItem[]; freeCells: number }> {
    const config = this.options.config;
    if (!config.shopTab) throw new Error("shop-tab-not-configured");
    if (!(await this.gotoShop())) throw new Error("merchant-tab-unreachable");
    await this.requirePanel("merchant");
    const result = await this.sorter.scanTab(this.source(), { navigate: false });
    if (!result.ok) throw new Error(`shop-scan-failed:${result.reason}`);
    // Prices come from each item's hover tooltip ("Asking Price"), never
    // from the Ctrl+C text — one extra hover + OCR read per listed item.
    const inputs = [];
    for (const item of result.modelItems) {
      await this.harness.checkpoint("reading asking prices");
      const asking = await this.readAskingPrice({ x: item.cells[0]!.x, y: item.cells[0]!.y });
      inputs.push({
        text: item.text,
        cells: item.cells,
        ...(asking ? { askingPrice: { amount: asking.amount, currency: asking.currency } } : {}),
      });
    }
    const snapshot = buildShopSnapshot(
      inputs,
      {
        at: this.now().toISOString(),
        tab: config.shopTab,
        unreadCells: result.unread.length,
        ...(this.table ? { priceTable: this.table } : {}),
      },
    );
    const usedCells = result.modelItems.reduce((sum, item) => sum + item.cells.length, 0);
    const freeCells = Math.max(0, result.cols * result.rows - usedCells - result.unread.length);
    this.log(
      `shop scan: ${snapshot.items.length} item(s) in "${config.shopTab}" ` +
        `(${snapshot.unpricedCount} unpriced, ${result.unread.length} unread cell(s), ${freeCells} free cell(s))`,
    );
    return { snapshot, items: result.modelItems, freeCells };
  }

  /**
   * Diff the scan against the ledger. `record` appends the reconciliation
   * events (sold/hand-listed/hand-repriced); a dry-run prints them instead.
   * Returns the post-reconcile state either way.
   */
  reconcile(
    snapshot: ShopSnapshot,
    options: {
      record: boolean;
      knownElsewhere?: ReadonlySet<string>;
      /** The Earnings sub-tab's delta since the last recorded scan: upgrades
       * the heuristic "sold" rows it accounts for to verified. */
      earningsDelta?: EarningsDelta;
    } = { record: false },
  ): { state: ActiveListing[]; events: ListingEvent[]; report: string[] } {
    const ledger = this.loadLedger();
    const prior = deriveShopState(ledger);
    const reconciled = reconcileShopScan({
      state: prior,
      snapshot,
      ...(options.knownElsewhere ? { knownElsewhere: options.knownElsewhere } : {}),
      ...(this.table ? { priceTable: this.table } : {}),
    });
    let events = reconciled.events;
    const report = [...reconciled.report];
    if (options.earningsDelta) {
      const goneListings = prior.filter((listing) =>
        events.some((event) => event.kind === "sold" && event.fingerprint === listing.fingerprint),
      );
      const verified = verifySalesWithEarnings({ events, goneListings, earningsDelta: options.earningsDelta });
      events = verified.events;
      report.push(...verified.report);
    } else if (events.some((event) => event.kind === "sold")) {
      report.push("no Earnings delta this scan — presumed sales stay heuristic");
    }
    for (const line of report) this.log(`  · ${line}`);
    if (options.record) this.appendEvents(events);
    else if (events.length > 0) {
      this.log(`  · ${events.length} reconcile event(s) NOT recorded (dry-run — pass --record)`);
    }
    const state = deriveShopState([...ledger, ...events]);
    return { state, events, report };
  }

  /**
   * Build the action plan: reprice/delist decisions for app-priced listings,
   * price suggestions for unpriced items. Comps lookups go through the
   * caller's rate-limited provider and are capped.
   */
  async plan(
    snapshot: ShopSnapshot,
    state: readonly ActiveListing[],
    options: { compsLimit?: number } = {},
  ): Promise<ShopPlan> {
    const config = this.options.config;
    const nowMs = this.now().getTime();
    const at = this.now().toISOString();
    const actions: ShopAction[] = [];
    const holds: ShopHold[] = [];
    const report: string[] = [];
    let compsBudget = compsBudgetFor(options.compsLimit, 20);

    const byPrint = new Map(state.map((listing) => [listing.fingerprint, listing]));
    const suggestionFor = async (
      item: ShopSnapshotItem,
    ): Promise<PriceSuggestion | PriceRefusal | undefined> => {
      if (!this.options.comps || compsBudget <= 0) return undefined;
      compsBudget -= 1;
      const comps = await this.options.comps(item.text);
      if (comps === "rate-limited") compsBudget = 0;
      if (!comps || comps === "rate-limited") return undefined;
      return suggestListingPrice(comps, config, {
        at,
        ...(this.table ? { priceTable: this.table } : {}),
      });
    };

    for (const item of snapshot.items) {
      const listing = byPrint.get(item.fingerprint);
      if (!listing) continue; // reconcile handles unknown items
      // Comps are paced seconds apart: Numpad 0 must land between them.
      await this.harness.checkpoint(`plan: ${item.name}`);
      const priced = item.note && item.note.kind !== "other";
      if (!priced && !config.tabWidePrice) {
        const suggestion = await suggestionFor(item);
        if (suggestion && !isPriceRefusal(suggestion)) {
          actions.push({
            kind: "price-unpriced",
            fingerprint: item.fingerprint,
            name: item.name,
            itemClass: item.itemClass,
            cell: item.cells[0]!,
            to: suggestion.display,
            badges: ["UNPRICED"],
            reasons: [
              `no price note and no tab-wide price — suggest ${suggestion.display.amount} ${suggestion.display.currency}`,
              ...suggestion.cautions,
            ],
          });
        } else {
          holds.push({
            fingerprint: item.fingerprint,
            name: item.name,
            badges: ["UNPRICED"],
            reasons: [
              suggestion && isPriceRefusal(suggestion)
                ? `unpriced and comps unusable (${suggestion.detail})`
                : "unpriced and no comps available — price it by hand or raise the comps limit",
            ],
          });
        }
        continue;
      }
      const rawSuggestion = listing.by === "app" ? await suggestionFor(item) : undefined;
      const decision = repriceDecision({
        listing,
        ...(rawSuggestion ? { suggestion: rawSuggestion } : {}),
        config,
        nowMs,
        ...(this.table ? { priceTable: this.table } : {}),
      });
      if (decision.action === "hold") {
        holds.push({
          fingerprint: item.fingerprint,
          name: item.name,
          badges: decision.badges,
          reasons: decision.reasons,
        });
        continue;
      }
      actions.push({
        kind: decision.action === "delist" ? "delist" : "reprice",
        fingerprint: item.fingerprint,
        name: item.name,
        itemClass: item.itemClass,
        cell: item.cells[0]!,
        ...(listing.price ? { from: listing.price } : {}),
        ...(decision.to ? { to: decision.to } : {}),
        badges: decision.badges,
        reasons: decision.reasons,
      });
    }

    if (actions.length > config.maxActionsPerRun) {
      report.push(
        `${actions.length} action(s) planned, capped at ${config.maxActionsPerRun} per run — rerun for the rest`,
      );
      actions.length = config.maxActionsPerRun;
    }
    return { at, tab: config.shopTab, actions, holds, report };
  }

  // -------------------------------------------------------------------------
  // Phase 1: apply (live only)
  // -------------------------------------------------------------------------

  /**
   * Execute a plan against the live shop tab. Reprices and unpriced-pricing
   * first (the tab stays active), delists last (they end on the return tab).
   * Every price write is verified by a Note re-read; every delist by bag
   * growth plus a verified return deposit.
   */
  async apply(plan: ShopPlan, scanItems: readonly IdentifiedItem[]): Promise<{
    applied: number;
    failed: number;
    events: ListingEvent[];
  }> {
    if (this.options.dryRun) throw new Error("shop-apply-refused-in-dry-run");
    const config = this.options.config;
    const events: ListingEvent[] = [];
    let applied = 0;
    let failed = 0;
    const cellItem = (action: ShopAction): IdentifiedItem | undefined =>
      scanItems.find((item) =>
        item.cells.some((cell) => cell.row === action.cell?.row && cell.col === action.cell?.col),
      );

    const priceActions = plan.actions.filter((action) => action.kind !== "delist");
    const delistActions = plan.actions.filter((action) => action.kind === "delist");

    if (priceActions.length > 0) {
      if (!(await this.gotoShop())) throw new Error("shop-tab-unreachable");
      for (const action of priceActions) {
        const item = cellItem(action);
        if (!item || !action.to) {
          failed += 1;
          this.log(`  ! ${action.name}: no scanned cell/target price — skipped`);
          continue;
        }
        const outcome = await this.setItemPrice(
          { x: item.cells[0]!.x, y: item.cells[0]!.y },
          action.to,
          action.name,
        );
        if (!outcome.ok) {
          failed += 1;
          this.log(`  ! ${action.name}: price write failed (${outcome.reason}) — reported, not retried`);
          continue;
        }
        applied += 1;
        // "price-unpriced" is also a reprice event: the reconcile already
        // recorded the hand-listing, so a "listed" here would double-count
        // the copy — the price write is what changes hands (by: app).
        events.push({
          at: this.now().toISOString(),
          kind: "repriced",
          fingerprint: action.fingerprint,
          name: action.name,
          itemClass: action.itemClass,
          count: 1,
          by: "app",
          certainty: "verified",
          price: {
            amount: action.to.amount,
            currency: action.to.currency,
            exalted: action.to.exalted,
          },
          ...(action.from ? { previousPrice: action.from } : {}),
          ...(action.cell ? { cell: action.cell } : {}),
          reason: action.reasons[0] ?? "",
        });
      }
    }

    for (const action of delistActions) {
      const item = cellItem(action);
      if (!item) {
        failed += 1;
        this.log(`  ! ${action.name}: no scanned cells to withdraw — skipped`);
        continue;
      }
      const done = await this.delistItems([{ action, item }]);
      applied += done.applied;
      failed += done.failed;
      events.push(...done.events);
    }

    this.appendEvents(events);
    return { applied, failed, events };
  }

  private async gotoShop(): Promise<boolean> {
    if (!(await this.ensureMerchantOpen())) return false;
    return this.selectMerchantTab(this.options.config.shopTab);
  }

  /**
   * Delist = ctrl-click the listed item back into the bag (verified-serial,
   * bag growth is the commit signal). The items stay in the BAG: moving
   * them on to the return stash tab means closing the Merchant panel and
   * opening the stash, which is reported for the user rather than driven.
   */
  private async delistItems(
    batch: ReadonlyArray<{ action: ShopAction; item: IdentifiedItem }>,
  ): Promise<{ applied: number; failed: number; events: ListingEvent[] }> {
    const config = this.options.config;
    const events: ListingEvent[] = [];
    if (!(await this.gotoShop())) throw new Error("shop-tab-unreachable");
    const withdrawn = await this.sorter.withdrawItemsSerial(
      batch.map((entry) => entry.item),
      config.shopTab,
    );
    if (withdrawn.length === 0) {
      return { applied: 0, failed: batch.length, events };
    }
    this.log(
      `  · ${withdrawn.length} delisted item(s) are in the bag — move them to ${config.returnTab} by hand (stash + merchant cannot be open together)`,
    );
    let applied = 0;
    for (const { action, item } of batch) {
      if (!withdrawn.includes(item)) continue;
      applied += 1;
      events.push({
        at: this.now().toISOString(),
        kind: "delisted",
        fingerprint: action.fingerprint,
        name: action.name,
        itemClass: action.itemClass,
        count: 1,
        by: "app",
        certainty: "verified",
        ...(action.from ? { previousPrice: action.from } : {}),
        reason: action.reasons[0] ?? "ladder floor",
      });
    }
    return { applied, failed: batch.length - applied, events };
  }

  // -------------------------------------------------------------------------
  // The per-item price dialog (NEW driving — taught anchors, verified writes)
  // -------------------------------------------------------------------------

  private loadDialogCalibration(): ShopDialogCalibration | undefined {
    try {
      if (!existsSync(this.dialogFile)) return undefined;
      const parsed = JSON.parse(readFileSync(this.dialogFile, "utf8")) as ShopDialogCalibration;
      return parsed.version === 2 && parsed.offsets?.amount && parsed.offsets?.confirm
        ? parsed
        : undefined;
    } catch {
      return undefined;
    }
  }

  private saveDialogCalibration(calibration: ShopDialogCalibration): void {
    mkdirSync(this.outDir, { recursive: true });
    writeFileSync(this.dialogFile, JSON.stringify(calibration, null, 2));
  }

  /** Both anchors of an OPEN pricing dialog, or undefined. */
  private findDialogAnchors(
    lines: readonly OcrLine[],
  ): { title: { line: OcrLine; pattern: RegExp }; row: { line: OcrLine; pattern: RegExp } } | undefined {
    const title = findLine(lines, DIALOG_TITLE_ANCHORS);
    const row = findLine(lines, DIALOG_ROW_ANCHORS);
    return title && row ? { title, row } : undefined;
  }

  /**
   * The currency the price row currently shows — the selector REMEMBERS the
   * last currency used (it opened on Divine Orb after a divine listing), so
   * it is read every time, never assumed.
   */
  private currencyOnRow(
    lines: readonly OcrLine[],
    rowCentre: { x: number; y: number },
  ): string | undefined {
    const candidates = lines
      .filter((line) => {
        const centre = anchorCentre(line);
        return (
          Math.abs(centre.y - rowCentre.y) < 40 &&
          centre.x < rowCentre.x - 100 &&
          /orb/i.test(line.text)
        );
      })
      .sort((a, b) => b.x - a.x);
    return candidates[0] ? currencyFromLabel(candidates[0].text) : undefined;
  }

  /**
   * Hover a listed item and read its Asking Price from the tooltip. The
   * mouse stays on the cell for the settled OCR read, then parks.
   */
  async readAskingPrice(point: { x: number; y: number }): Promise<AskingPrice | undefined> {
    let result: AskingPrice | undefined;
    let lastLines: OcrLine[] = [];
    // The tooltip needs a beat to appear after the cursor arrives from the
    // park spot (350ms read empty live, 500ms read fine); a nudge re-hovers.
    for (const nudge of [0, 9, -9]) {
      await this.host.send({ op: "move", x: point.x + nudge, y: point.y + nudge });
      await this.harness.sleep(nudge === 0 ? 550 : 400, false);
      lastLines = await this.kit.settledOcr(3);
      let read = parseAskingPrice(lastLines);
      // The amount glyph ("1x", "5x") is too small for native-size OCR;
      // a 2x upscaled crop around the label reads it. The tooltip is still
      // up — the cursor has not moved.
      const label = lastLines.find((line) => isAskingPriceLabel(line.text));
      const cooldown = lastLines
        .filter((line) => isCooldownLine(line.text))
        .sort((a, b) => b.y - a.y)[0];
      const zoomAnchor = label ?? cooldown;
      if (zoomAnchor && (!read || read.amountAssumed)) {
        // Anchored on the cooldown line the crop reaches further down: the
        // value line can sit below what the native pass caught (2026-09-03).
        const zoom = await this.host.send({
          op: "ocr",
          left: Math.max(0, zoomAnchor.x - 250),
          top: Math.max(0, zoomAnchor.y - 30),
          width: 900,
          height: label ? 220 : 320,
          scale: 2,
        });
        const zoomLines = (Array.isArray(zoom.lines) ? zoom.lines : []) as OcrLine[];
        const zoomed = parseAskingPrice(zoomLines);
        if (zoomed && (!read || !zoomed.amountAssumed)) {
          read = { ...zoomed, raw: `${zoomed.raw} (2x zoom)` };
        }
      }
      if (read && (!result || !read.amountAssumed)) result = read;
      // A clean read ends it; an assumed amount earns one more look.
      if (result && !result.amountAssumed) break;
    }
    await this.park();
    if (!result) {
      const near = lastLines
        .filter((line) => Math.abs(line.x - point.x) < 900 && Math.abs(line.y - point.y) < 700)
        .slice(0, 12)
        .map((line) => `"${line.text}"`);
      this.log(`  · no asking price in the tooltip at (${point.x},${point.y}); OCR near it: ${near.join(" | ") || "(nothing)"}`);
    }
    return result;
  }

  /**
   * Right-click with the marker overlay (mirrors StashTabKit.pointer). It
   * opens the price dialog, so in step mode it waits for Numpad 8 like
   * every other gesture; Numpad 9 skips it (false — nothing was sent).
   */
  private async rightClick(x: number, y: number, why: string): Promise<boolean> {
    await this.harness.checkpoint(`before right-click: ${why}`);
    if (this.options.stepMode) {
      const verdict = await this.harness.confirmPlan(
        [{ x: Math.round(x) - 22, y: Math.round(y) - 22, w: 44, h: 44, kind: "click" }],
        `right-click: ${why}`,
      );
      if (verdict === "wrong") return false;
    } else {
      await this.host
        .send({
          op: "marks",
          rects: [{ x: Math.round(x) - 22, y: Math.round(y) - 22, w: 44, h: 44, kind: "click", label: why }],
        })
        .catch(() => undefined);
      await this.harness.sleep(400, false);
    }
    await this.host.send({ op: "rightclick", x: Math.round(x), y: Math.round(y) });
    await this.host.send({ op: "hidemark" }).catch(() => undefined);
    return true;
  }

  private async park(): Promise<void> {
    await this.host.send({ op: "move", ...PARK });
  }

  /**
   * A gated click. A Numpad-9 correction means the USER clicked the right
   * spot themselves (their click acts in-game and is recorded), so the step
   * still counts as done — only Numpad 0 stops a run.
   */
  private async clickStep(x: number, y: number, why: string): Promise<void> {
    const verdict = await this.harness.click(x, y, why);
    if (verdict === "corrected") {
      this.log(`  · ${why}: done by your corrected click — continuing`);
      await this.harness.sleep(400, false);
    }
  }

  /**
   * Set one listed item's price via its right-click dialog (the same SET
   * ITEM PRICE dialog a fresh placement opens, pre-filled with the current
   * price), and verify by re-reading the tooltip's Asking Price. Returns a
   * reported failure rather than retrying blind past one more attempt.
   */
  async setItemPrice(
    point: { x: number; y: number },
    price: DenominatedPrice,
    name: string,
  ): Promise<PriceWriteOutcome> {
    if (this.options.dryRun) return { ok: false, reason: "dry-run" };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const outcome = await this.tryPriceDialog(point, price, name, attempt);
      if (outcome.ok) return outcome;
      if (
        outcome.reason === "dialog-not-taught" ||
        outcome.reason === "currency-not-taught" ||
        outcome.reason === "right-click-rejected"
      ) {
        return outcome; // teaching and a step-mode refusal are user actions, not retries
      }
      this.log(
        `  · ${name}: price write attempt ${attempt + 1} failed (${outcome.reason}${outcome.readBack ? `; tooltip read "${outcome.readBack}"` : "; no tooltip read"})`,
      );
    }
    return { ok: false, reason: "asking-price-verify-failed-twice" };
  }

  private async tryPriceDialog(
    point: { x: number; y: number },
    price: DenominatedPrice,
    name: string,
    attempt: number,
  ): Promise<PriceWriteOutcome> {
    await this.host.send({ op: "focus" });
    await this.harness.sleep(200, false);
    if (!(await this.rightClick(point.x, point.y, `price dialog: ${name}`))) {
      return { ok: false, reason: "right-click-rejected" };
    }
    await this.park();
    const filled = await this.fillOpenPriceDialog(price, name, attempt);
    if (!filled.ok) return filled;

    // The write is only real when the item's own tooltip says so.
    const asking = await this.readAskingPrice(point);
    if (asking && priceMatches(asking, price)) {
      this.log(`  · ${name}: asking price verified — ${asking.raw}`);
      return { ok: true, readBack: asking.raw };
    }
    return {
      ok: false,
      reason: "asking-price-mismatch",
      ...(asking ? { readBack: asking.raw } : {}),
    };
  }

  /**
   * Drive an ALREADY OPEN pricing dialog (a right-click reprice, or the one
   * a ctrl-click from the bag pops up): anchors → currency → amount → LIST
   * ITEM. On any failure the dialog is closed and the reason reported; no
   * verification happens here — the caller reads the tooltip afterwards.
   */
  async fillOpenPriceDialog(
    price: DenominatedPrice,
    name: string,
    attempt = 0,
  ): Promise<PriceWriteOutcome> {
    const lines = await this.kit.settledOcr();
    const anchors = this.findDialogAnchors(lines);
    if (!anchors) {
      // The dialog either did not open or uses words we have not seen.
      // Log what IS on screen so the anchor lists can be extended live.
      if (attempt === 0) {
        this.log(`  · ${name}: pricing-dialog anchors not found (need title + LIST ITEM); OCR saw:`);
        for (const line of lines.slice(0, 24)) {
          this.log(`      (${line.x},${line.y}) "${line.text}"`);
        }
      }
      await this.closeDialogBestEffort(undefined, undefined);
      return { ok: false, reason: "dialog-anchor-not-found" };
    }
    const titleCentre = anchorCentre(anchors.title.line);
    const rowCentre = anchorCentre(anchors.row.line);
    let calibration = this.loadDialogCalibration();
    if (!calibration) {
      if (!this.options.stepMode) {
        await this.closeDialogBestEffort(undefined, titleCentre);
        return { ok: false, reason: "dialog-not-taught" };
      }
      calibration = await this.teachDialog(anchors.title, anchors.row);
      if (!calibration) {
        await this.closeDialogBestEffort(undefined, titleCentre);
        return { ok: false, reason: "dialog-teach-aborted" };
      }
    }
    const at = (offset: Offset) => ({ x: rowCentre.x + offset.dx, y: rowCentre.y + offset.dy });

    // Currency first: the selector shows whatever was used LAST — read it.
    const current = this.currencyOnRow(lines, rowCentre);
    if (current !== price.currency) {
      const open = calibration.offsets.currencyOpen;
      const option = calibration.currencyOptions[price.currency];
      if (!open || !option) {
        if (this.options.stepMode) {
          const taught = await this.teachCurrency(calibration, anchors.row.line, price.currency);
          if (!taught) {
            await this.closeDialogBestEffort(calibration, titleCentre);
            return { ok: false, reason: "currency-not-taught" };
          }
          calibration = taught;
        } else {
          await this.closeDialogBestEffort(calibration, titleCentre);
          return { ok: false, reason: "currency-not-taught" };
        }
      }
      const openPoint = at(calibration.offsets.currencyOpen!);
      await this.clickStep(openPoint.x, openPoint.y, `currency selector (${name})`);
      await this.harness.sleep(450, false);
      const optionPoint = at(calibration.currencyOptions[price.currency]!);
      await this.clickStep(optionPoint.x, optionPoint.y, `currency: ${price.currency} (${name})`);
      await this.harness.sleep(350, false);
      // Never type an amount against the wrong currency: re-read the row.
      const selected = this.currencyOnRow(await this.kit.settledOcr(), rowCentre);
      if (selected !== price.currency) {
        await this.closeDialogBestEffort(calibration, titleCentre);
        return { ok: false, reason: `currency-not-selected:${selected ?? "unread"}` };
      }
    }

    // Amount + LIST ITEM are ONE approved step. The amount field keeps
    // keyboard focus after typing, so a step-mode Numpad 8 pressed to
    // approve a separate LIST ITEM click lands IN the field ("1" → "18",
    // three items listed at 18 divine, 2026-09-02). Gate first, then
    // click-clear-type-confirm with no keystroke of the user's in between.
    const amountPoint = at(calibration.offsets.amount);
    const confirmPoint = at(calibration.offsets.confirm);
    if (this.options.stepMode) {
      const verdict = await this.harness.confirmPlan(
        [
          { x: amountPoint.x - 25, y: amountPoint.y - 25, w: 50, h: 50, kind: "click" },
          { x: confirmPoint.x - 25, y: confirmPoint.y - 25, w: 50, h: 50, kind: "click" },
        ],
        `type ${price.amount} into the amount field, then LIST ITEM (${name})`,
      );
      if (verdict === "wrong") {
        await this.closeDialogBestEffort(calibration, titleCentre);
        return { ok: false, reason: "amount-step-rejected" };
      }
    }
    await this.harness.checkpoint(`amount + LIST ITEM (${name})`);
    await this.host.send({ op: "click", x: amountPoint.x, y: amountPoint.y });
    await this.harness.sleep(220, false);
    await this.host.send({ op: "hotkey", keys: "ctrla" });
    await this.harness.sleep(140, false);
    await this.host.send({ op: "hotkey", keys: "backspace" });
    await this.harness.sleep(140, false);
    await this.host.send({ op: "type", text: String(price.amount) });
    await this.harness.sleep(260, false);
    await this.host.send({ op: "click", x: confirmPoint.x, y: confirmPoint.y });
    await this.park();
    await this.harness.sleep(600, false);
    return { ok: true };
  }

  /**
   * Bring every item in a merchant tab to one price: items whose tooltip
   * already reads it are skipped; the rest are right-clicked into the price
   * dialog (also how an unpriced, merely placed item gets its first price)
   * and verified by tooltip afterwards. Dry-run only reads and reports.
   */
  async repriceTabItems(
    tabLabel: string,
    price: DenominatedPrice,
  ): Promise<{ repriced: number; skipped: number; failed: number; report: string[] }> {
    const report: string[] = [];
    let repriced = 0;
    let skipped = 0;
    let failed = 0;
    if (this.options.assumeCurrentTab && !(await this.merchantOpen())) {
      throw new Error("merchant-not-open — --current needs the wanted tab already on screen");
    }
    if (!(await this.ensureMerchantOpen())) throw new Error("merchant-panel-not-open");
    if (!(await this.selectMerchantTab(tabLabel))) throw new Error("merchant-tab-unreachable");
    await this.requirePanel("merchant");
    // shop: true pins the merchant tab's 12x12 grid (a crowded tab fooled
    // the lattice detector into 24x24 live on 2026-09-03).
    const scan = await this.sorter.scanTab(
      { label: tabLabel, occurrence: 0, shop: true },
      { navigate: false },
    );
    if (!scan.ok) throw new Error(`shop-scan-failed:${scan.reason}`);
    const events: ListingEvent[] = [];
    const known = new Set(deriveShopState(this.loadLedger()).map((listing) => listing.fingerprint));
    for (const item of scan.modelItems) {
      const name =
        item.text
          .split(/\r?\n/)
          .map((line) => line.trim())
          .find((line) => line && !/^(Item Class|Rarity):/i.test(line) && line !== "--------") ?? "item";
      const point = { x: item.cells[0]!.x, y: item.cells[0]!.y };
      await this.harness.checkpoint(`reprice check ${name}`);
      const current = await this.readAskingPrice(point);
      if (current && priceMatches(current, price)) {
        skipped += 1;
        report.push(`${name}: already ${current.raw}${current.locked ? " [cooldown]" : ""}`);
        const fingerprint = parseItemText(item.text).fingerprint;
        if (!known.has(fingerprint)) {
          // Listed by this flow earlier but never recorded (verification
          // OCR failed then) — adopt it now rather than leave a gap.
          const exalted = noteExalted(
            { kind: "price", amount: price.amount, currency: price.currency, raw: current.raw },
            this.table,
          );
          events.push({
            at: this.now().toISOString(),
            kind: "listed",
            fingerprint,
            name,
            itemClass: item.itemClass ?? "Unknown",
            count: 1,
            by: "app",
            certainty: current.amountAssumed ? "heuristic" : "verified",
            price: { amount: price.amount, currency: price.currency, ...(exalted !== undefined ? { exalted } : {}) },
            cell: { row: item.cells[0]!.row, col: item.cells[0]!.col },
            reason: "found at the tab price without a ledger record (adopted by the reprice pass)",
          });
          known.add(fingerprint);
        }
        continue;
      }
      if (this.options.dryRun) {
        report.push(`${name}: reads ${current ? `"${current.raw}"` : "no asking price"} → would set ${price.amount} ${price.currency}`);
        continue;
      }
      const outcome = await this.setItemPrice(point, price, name);
      if (!outcome.ok) {
        failed += 1;
        report.push(`${name}: reprice failed (${outcome.reason}${outcome.readBack ? `, tooltip "${outcome.readBack}"` : ""})`);
        continue;
      }
      repriced += 1;
      report.push(`${name}: ${current ? `"${current.raw}"` : "unpriced"} → ${outcome.readBack}`);
      const exalted = noteExalted(
        { kind: "price", amount: price.amount, currency: price.currency, raw: outcome.readBack ?? "" },
        this.table,
      );
      events.push({
        at: this.now().toISOString(),
        kind: current ? "repriced" : "listed",
        fingerprint: parseItemText(item.text).fingerprint,
        name,
        itemClass: item.itemClass ?? "Unknown",
        count: 1,
        by: "app",
        certainty: "verified",
        price: { amount: price.amount, currency: price.currency, ...(exalted !== undefined ? { exalted } : {}) },
        ...(current ? { previousPrice: { amount: current.amount, currency: current.currency } } : {}),
        cell: { row: item.cells[0]!.row, col: item.cells[0]!.col },
        reason: "reprice pass",
      });
    }
    // A dry-run reads and reports; the ledger is written by live passes
    // only (adoptions included — the tooltip read is real, the run is not).
    if (this.options.dryRun) {
      if (events.length > 0) {
        report.push(`${events.length} adoption(s) NOT recorded (dry-run — a --live reprice pass records them)`);
      }
    } else {
      this.appendEvents(events);
    }
    return { repriced, skipped, failed, report };
  }

  /**
   * Phase 2 on price-bucket tabs: each bag item's value estimate snaps DOWN
   * to the dearest bucket it clears and the item is listed in that tab at
   * the bucket's price. No estimate, a keep/dump tier, or a value under the
   * cheapest bucket = the item stays in the bag, with the reason reported.
   */
  async planBagBuckets(
    buckets: readonly BucketTab[],
    options: { compsLimit?: number } = {},
  ): Promise<{ plan: BucketPlanEntry[]; held: string[]; vendor: VendorEntry[] }> {
    const evaluate = this.options.evaluate;
    if (!evaluate) throw new Error("shop-list-needs-evaluator");
    if (buckets.length === 0) throw new Error("no-bucket-tabs");
    const config = this.options.config;
    const at = this.now().toISOString();
    let compsBudget = compsBudgetFor(options.compsLimit, 15);
    await this.requirePanel("inventory");
    const { items, unread } = await this.sorter.identifyBagItems();
    const held: string[] = [];
    const plan: BucketPlanEntry[] = [];
    const vendor: VendorEntry[] = [];
    let rateLimited = false;
    if (unread.length > 0) held.push(`${unread.length} bag cell(s) unreadable — left alone`);
    // Local screen first (core/lookupScreen.ts): only items with notable
    // mods, or uniques the price table lacks, earn a trade2 lookup — best
    // candidates first, so a spent budget lands on the items most likely to
    // beat the floor. Plain rares list at the cheapest bucket untouched.
    const verdicts = items.map((item) => evaluate(item.text));
    const decisions = screenForLookup(
      items.map((item, index) => {
        const parsed = parseItemText(item.text);
        const verdict = verdicts[index]!;
        return {
          key: String(index),
          name: itemNameOf(item.text),
          tier: verdict.tier,
          rarity: parsed.rarity,
          ...(parsed.baseType ? { baseType: parsed.baseType } : {}),
          ...(parsed.itemLevel !== undefined ? { itemLevel: parsed.itemLevel } : {}),
          ...(verdict.appraisal ? { appraisal: verdict.appraisal } : {}),
        };
      }),
    );
    this.log(`  · ${summarizeScreen(decisions)}`);
    const floorBucket = buckets[0]!;
    for (const decision of decisions) {
      const index = Number(decision.key);
      const item = items[index]!;
      const appraisal = verdicts[index]!.appraisal;
      const name = decision.name;
      const itemClass = item.itemClass ?? "Unknown";
      if (decision.route === "keep") {
        held.push(`${name}: ${decision.reason}`);
        continue;
      }
      if (decision.route === "vendor") {
        vendor.push({ item, name, itemClass, reason: decision.reason });
        continue;
      }
      let estimate: number | undefined;
      let basis = "";
      let stack: StackListingInfo | undefined;
      if (decision.route === "local-price" && appraisal?.estimatedValue) {
        // A currency STACK is bucketed under the configured stack-pricing
        // mode — whole (unit × count) or per-unit — because whether SET ITEM
        // PRICE prices the stack or the orb is unverified live.
        const stacked = stackBucketValue(appraisal.estimatedValue, config.stackPricing);
        if (stacked) {
          estimate = stacked.value;
          basis = `price table ${stacked.label}`;
          stack = { count: stacked.count, mode: stacked.mode, unitValue: stacked.unitValue, label: stacked.label };
        } else {
          estimate = appraisal.estimatedValue.amount;
          basis = "price table";
        }
      } else if (decision.route === "floor") {
        estimate = floorBucket.exalted;
        basis = `floor — ${decision.reason}`;
      } else if (decision.route === "lookup") {
        if (!this.options.comps || compsBudget <= 0 || rateLimited) {
          held.push(
            `${name}: pending pricing (${decision.reason}) — ${
              rateLimited
                ? "trade2 rate limited; press the key again once the window lifts"
                : "lookup budget spent this run; press the key again"
            }`,
          );
          continue;
        }
        compsBudget -= 1;
        // Comps are paced seconds apart: Numpad 0 must land between them.
        await this.harness.checkpoint(`pricing ${name}`);
        const comps = await this.options.comps(item.text);
        if (comps === "rate-limited") {
          compsBudget = 0;
          rateLimited = true;
          held.push(
            `${name}: pending pricing (${decision.reason}) — trade2 rate limited; press the key again once the window lifts`,
          );
          this.log("  · trade2 rate limit reached — no more comps this run");
          continue;
        }
        this.log(
          `  · priced ${name}: ${comps ? `${comps.sampleSize} comp(s)` : "no comps"} (${decision.reason})`,
        );
        if (comps) {
          const suggestion = suggestListingPrice(comps, config, {
            at,
            ...(this.table ? { priceTable: this.table } : {}),
          });
          if (isPriceRefusal(suggestion)) {
            if (suggestion.refusal === "below-floor") {
              // Priced by real comps, under the cheapest listing: vendor it.
              vendor.push({ item, name, itemClass, reason: suggestion.detail });
            } else {
              held.push(`${name}: comps unusable (${suggestion.detail}) — stays in the bag`);
            }
            continue;
          }
          estimate = suggestion.targetExalted;
          basis = `comps p${config.compsPercentile} -${config.undercutPercent}%`;
        }
      }
      if (estimate === undefined) {
        held.push(
          `${name}: no value estimate (${appraisal ? `confidence ${appraisal.confidence}` : "no appraisal"}) — stays in the bag`,
        );
        continue;
      }
      const bucket = bucketFor(estimate, buckets);
      if (!bucket) {
        vendor.push({
          item,
          name,
          itemClass,
          reason: `≈${Math.round(estimate * 100) / 100} ex is under the cheapest bucket (${buckets[0]!.label})`,
        });
        continue;
      }
      plan.push({
        item,
        name,
        itemClass,
        bucket,
        estimateExalted: Math.round(estimate * 100) / 100,
        basis,
        ...(stack ? { stack } : {}),
      });
    }
    return { plan, held, vendor };
  }

  /**
   * Sell bag items to ZELINA. PoE2 vendors sell on ctrl-click INSTANTLY (no
   * offer pane — proven by scripts/vendor-cycle.ts; a mis-sale is
   * recoverable from her Buyback tab). Only items the plan priced UNDER the
   * cheapest bucket, or that the value tiers call dump, ever reach here.
   * Verified per cell by an empty Ctrl+C read afterwards.
   */
  async vendorBagItems(
    entries: readonly VendorEntry[],
  ): Promise<{ sold: number; failed: number; report: string[] }> {
    if (this.options.dryRun) throw new Error("shop-apply-refused-in-dry-run");
    const report: string[] = [];
    if (entries.length === 0) return { sold: 0, failed: 0, report };
    // Close the Merchant/inventory so the world (her nameplate) is visible.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const panels = await panelsViaOcr(this.host);
      const merchant = await this.merchantOpen();
      if (!panels.stash && !panels.inventory && !merchant) break;
      await this.host.send({ op: "hotkey", keys: "escape" });
      await this.harness.sleep(500, false);
    }
    // Open her window: ctrl-click the nameplate (Alt held renders world plates).
    let opened = false;
    for (let attempt = 0; attempt < 2 && !opened; attempt += 1) {
      // Cached-position band OCR first, full-screen fallback (nameplateFinder);
      // the click point is the plate centre +70px, as before.
      const plate = await findNameplate(this.host, /^zelina$/i, {
        cacheKey: "zelina",
        cacheFile: defaultNameplateCacheFile(this.options.root),
        holdAlt: true,
        log: (line) => this.log(`  · ${line}`),
      });
      if (!plate) {
        report.push("ZELINA's nameplate is not on screen — stand near her in the hideout");
        return { sold: 0, failed: entries.length, report };
      }
      const point = { x: plate.x, y: plate.y };
      await this.harness.checkpoint("open ZELINA");
      if (this.options.stepMode) {
        const verdict = await this.harness.confirmPlan(
          [{ x: point.x - 25, y: point.y - 25, w: 50, h: 50, kind: "click" }],
          "ctrl-click ZELINA to open her window",
        );
        if (verdict === "wrong") return { sold: 0, failed: entries.length, report: [...report, "ZELINA click rejected"] };
      }
      const clicked = await this.host.send({ op: "ctrlclick", x: point.x, y: point.y });
      if (!clicked.ok) throw new Error(`ctrlclick-zelina-failed:${String(clicked.error)}`);
      for (let poll = 0; poll < 10 && !opened; poll += 1) {
        await this.harness.sleep(450, false);
        await this.park();
        const band = await this.host.send({ op: "ocr", left: 750, top: 1700, width: 1100, height: 150 });
        opened = /type keyword|buy or sell/i.test(String(band.text ?? ""));
      }
    }
    if (!opened) {
      report.push("ZELINA's window did not open — nothing sold");
      return { sold: 0, failed: entries.length, report };
    }
    const points = entries.map((entry) => entry.item.cells[0]!);
    const sent = await this.harness.burst(points, {
      cellW: 70,
      cellH: 70,
      label: `sell ${entries.length} item(s) to ZELINA (under 1 ex / dump-tier)`,
    });
    if (sent === 0) {
      await this.closeVendorWindow();
      return { sold: 0, failed: entries.length, report: [...report, "sell burst rejected"] };
    }
    await this.harness.sleep(600, false);
    // A sold cell copies EMPTY; one retry for cells the burst missed.
    let texts = await copyPoints(this.host, points.map((cell) => ({ x: cell.x, y: cell.y })), "sold");
    let stuck = entries.filter((_, index) => (texts[index] ?? "").trim());
    if (stuck.length > 0) {
      await this.harness.burst(
        stuck.map((entry) => entry.item.cells[0]!),
        { cellW: 70, cellH: 70, label: `retry ${stuck.length} unsold item(s)` },
      );
      await this.harness.sleep(600, false);
      texts = await copyPoints(this.host, points.map((cell) => ({ x: cell.x, y: cell.y })), "sold2");
      stuck = entries.filter((_, index) => (texts[index] ?? "").trim());
    }
    for (const entry of entries) {
      if (stuck.includes(entry)) report.push(`${entry.name}: did not sell — still in the bag`);
      else report.push(`${entry.name}: sold to ZELINA (${entry.reason})`);
    }
    await this.closeVendorWindow();
    return { sold: entries.length - stuck.length, failed: stuck.length, report };
  }

  /** Escape lands on her dialogue; leave through its own "Goodbye" line. */
  private async closeVendorWindow(): Promise<void> {
    await this.host.send({ op: "hotkey", keys: "escape" });
    await this.harness.sleep(450, false);
    const lines = await findOcrLines(this.host);
    const goodbye = lines.find((line) => /goodbye/i.test(line.text));
    if (goodbye) {
      const point = lineCenter(goodbye);
      await this.host.send({ op: "click", x: point.x, y: point.y });
      await this.harness.sleep(350, false);
    }
  }

  /** Execute a bucket plan one tab at a time: select the tab, list its items at the bucket price. */
  async applyBagBuckets(
    plan: readonly BucketPlanEntry[],
  ): Promise<{ listed: number; failed: number; report: string[] }> {
    if (this.options.dryRun) throw new Error("shop-apply-refused-in-dry-run");
    const groups = new Map<string, BucketPlanEntry[]>();
    for (const entry of plan) {
      groups.set(entry.bucket.label, [...(groups.get(entry.bucket.label) ?? []), entry]);
    }
    let listed = 0;
    let failed = 0;
    const report: string[] = [];
    for (const [label, entries] of groups) {
      const bucket = entries[0]!.bucket;
      const price: DenominatedPrice = {
        amount: bucket.amount,
        currency: bucket.currency,
        exalted: bucket.exalted,
      };
      const result = await this.listBagItems(
        entries.map((entry) => ({
          item: entry.item,
          price,
          name: entry.name,
          itemClass: entry.itemClass,
          ...(entry.stack ? { stack: entry.stack } : {}),
        })),
        label,
      );
      listed += result.listed;
      failed += result.failed;
      report.push(...result.report.map((line) => `[${label}] ${line}`));
    }
    return { listed, failed, report };
  }

  /**
   * List bag items in the merchant tab: ctrl-click each one (the game moves
   * it into the open merchant tab and pops the SET ITEM PRICE dialog), fill
   * the dialog, confirm the bag cell emptied, then verify the listing by its
   * tooltip before recording it. Nothing is written to the ledger that the
   * tooltip did not confirm.
   *
   * Verification is TARGETED by default: the game places a ctrl-clicked
   * item at the tab's first free position, so the pixel-occupancy diff
   * against the pre-listing frame IS the landing spot — only those cells
   * are hovered (Ctrl+C fingerprint + Asking Price tooltip). A diff that
   * does not match the item's footprint, or a fingerprint that does not
   * match, falls back to the whole-tab rescan for that item (and says why);
   * `fullVerify` keeps the old whole-tab path for everything.
   */
  async listBagItems(
    entries: ReadonlyArray<ListBagEntry>,
    tabLabel: string,
  ): Promise<{ listed: number; failed: number; report: string[] }> {
    if (this.options.dryRun) throw new Error("shop-apply-refused-in-dry-run");
    const report: string[] = [];
    let listed = 0;
    let failed = 0;
    if (entries.length === 0) return { listed, failed, report };
    if (this.options.assumeCurrentTab && !(await this.merchantOpen())) {
      throw new Error("merchant-not-open — --current needs the wanted tab already on screen");
    }
    if (!(await this.ensureMerchantOpen())) throw new Error("merchant-panel-not-open");
    if (!(await this.selectMerchantTab(tabLabel))) throw new Error("merchant-tab-unreachable");
    await this.requirePanel("merchant");
    await this.requirePanel("inventory");
    // shop: true pins the merchant tab's 12x12 grid (see repriceTabItems).
    const source: SourceTab = { label: tabLabel, occurrence: 0, shop: true };
    const fingerprintOf = (text: string): string => parseItemText(text).fingerprint;

    const preScan = await this.sorter.scanTab(source, { navigate: false });
    if (!preScan.ok) throw new Error(`shop-scan-failed:${preScan.reason}`);
    const preCounts = new Map<string, number>();
    for (const item of preScan.modelItems) {
      const key = fingerprintOf(item.text);
      preCounts.set(key, (preCounts.get(key) ?? 0) + 1);
    }
    const targeted = !this.options.fullVerify;
    const geometry = { region: preScan.region, cols: preScan.cols, rows: preScan.rows };
    const cellKey = (cell: GridCell): string => `${cell.row},${cell.col}`;
    // The pixel baseline the landing-spot diff runs against. It moves on
    // after every listing whatever the verdict, so one ambiguous landing
    // never poisons the next item's diff.
    let occupiedBefore: GridCell[] = targeted ? await this.sorter.occupiedStashCellsNow(geometry) : [];

    const events: ListingEvent[] = [];
    const verifiedCounts = new Map<string, number>();
    // A fingerprint the ledger still holds as listed, with fewer copies in
    // the tab than the ledger says, left the shop by hand (the user moved
    // it back to the bag — 2026-09-03 produced double "listed" rows and a
    // phantom copy a later scan would have called sold). Record the implied
    // delist before the new listing so the derived count stays honest.
    const ledgerCounts = new Map(
      deriveShopState(this.loadLedger()).map((listing) => [listing.fingerprint, listing]),
    );
    const recordListed = (
      fingerprint: string,
      intent: { price: DenominatedPrice; name: string; itemClass: string },
      asking: AskingPrice,
      cell: ShopCell,
    ): void => {
      const alreadyThere = preCounts.get(fingerprint) ?? 0;
      const verified = verifiedCounts.get(fingerprint) ?? 0;
      listed += 1;
      verifiedCounts.set(fingerprint, verified + 1);
      const active = ledgerCounts.get(fingerprint);
      if (verified === 0 && active && active.count > alreadyThere) {
        events.push({
          at: this.now().toISOString(),
          kind: "delisted",
          fingerprint,
          name: intent.name,
          itemClass: intent.itemClass,
          count: active.count - alreadyThere,
          by: "user",
          certainty: "heuristic",
          previousPrice: active.price,
          reason: "left the shop by hand before this re-listing (implied by the bag listing)",
        });
      }
      const exalted = noteExalted(
        { kind: "price", amount: asking.amount, currency: asking.currency, raw: asking.raw },
        this.table,
      );
      events.push({
        at: this.now().toISOString(),
        kind: "listed",
        fingerprint,
        name: intent.name,
        itemClass: intent.itemClass,
        count: 1,
        by: "app",
        certainty: "verified",
        price: {
          amount: asking.amount,
          currency: asking.currency,
          ...(exalted !== undefined ? { exalted } : {}),
        },
        cell: { row: cell.row, col: cell.col },
        reason: "listed from the bag",
      });
    };

    /** Listings that left the bag but still need the whole-tab verification. */
    const wanted = new Map<string, { price: DenominatedPrice; name: string; itemClass: string; count: number }>();
    for (const [index, entry] of entries.entries()) {
      const cell = entry.item.cells[0]!;
      const fingerprint = fingerprintOf(entry.item.text);
      // Stack pricing is UNVERIFIED live: whether the dialog's amount buys
      // the whole stack or one orb decides the price by a factor of N. The
      // first stack of a run is step-gated even without --step so the user
      // reads the tooltip once; Numpad 9 skips the stack.
      if (entry.stack && !this.stackGateShown) {
        this.stackGateShown = true;
        const mode = entry.stack.mode === "whole" ? "for the WHOLE stack" : "PER UNIT";
        this.log(
          `  · first stack listing this run: ${entry.name} ${entry.stack.label} at ${entry.price.amount} ${entry.price.currency} ${mode} ` +
            `(unit ≈${entry.stack.unitValue} ex) — after LIST ITEM, hover it and check the tooltip's Asking Price is ${mode}; ` +
            'set "stackPricing" in shop.json if the game prices the other way',
        );
        const verdict = await this.harness.confirmPlan(
          [{ x: cell.x - 35, y: cell.y - 35, w: 70, h: 70, kind: "click" }],
          `FIRST STACK ${entry.stack.label}: ${entry.price.amount} ${entry.price.currency} ${mode} — check the tooltip after LIST ITEM · 8 = go · 9 = skip`,
        );
        if (verdict === "wrong") {
          failed += 1;
          report.push(`${entry.name}: ${entry.stack.label} skipped at the stack-pricing gate — set stackPricing in shop.json and rerun`);
          continue;
        }
      }
      const sent = await this.harness.burst([cell], {
        cellW: 70,
        cellH: 70,
        label: `list ${index + 1}/${entries.length}: ctrl-click ${entry.name}${entry.stack ? ` ${entry.stack.label}` : ""} → merchant tab "${tabLabel}"`,
      });
      if (sent === 0) {
        failed += 1;
        report.push(`${entry.name}: ctrl-click rejected — skipped`);
        continue;
      }
      await this.harness.sleep(800, false);
      const filled = await this.fillOpenPriceDialog(entry.price, entry.name);
      if (!filled.ok) {
        // Still in its bag cell = the game refused (runes never open the
        // dialog) or nothing happened: safe to go on. Gone from the bag
        // without a verified listing = unpriced in the tab, or on the
        // cursor — the next ctrl-click would act on top of it. Stop.
        const bagAfterFailure = await this.sorter.bagCellsNow();
        if (!bagAfterFailure.some((other) => other.row === cell.row && other.col === cell.col)) {
          throw await this.captureAndStop(
            "list-dialog",
            `${entry.name} left bag ${cell.row},${cell.col} but the price dialog failed (${filled.reason}) — it may sit unpriced in "${tabLabel}" or on the cursor; check the game`,
          );
        }
        failed += 1;
        report.push(`${entry.name}: price dialog failed (${filled.reason}) — still in the bag`);
        continue;
      }
      await this.harness.sleep(500, false);
      const bagNow = await this.sorter.bagCellsNow();
      if (bagNow.some((other) => other.row === cell.row && other.col === cell.col)) {
        failed += 1;
        report.push(`${entry.name}: still in the bag after LIST ITEM — not listed`);
        continue;
      }
      if (targeted) {
        // The dialog has closed and the item is out of the bag: the cells
        // that filled since the last frame are where it landed.
        await this.harness.sleep(250, false);
        const occupiedNow = await this.sorter.occupiedStashCellsNow(geometry);
        const known = new Set(occupiedBefore.map(cellKey));
        const landed = occupiedNow.filter((other) => !known.has(cellKey(other)));
        occupiedBefore = occupiedNow;
        const expected = entry.item.cells.length;
        let ambiguity: string | undefined;
        if (landed.length !== expected) {
          ambiguity = `${landed.length} cell(s) filled, the item covers ${expected}`;
        } else {
          const text = await this.sorter.copyAt(landed[0]!.x, landed[0]!.y);
          if (!text) ambiguity = `landing cell ${cellKey(landed[0]!)} copied nothing`;
          else if (fingerprintOf(text) !== fingerprint) {
            ambiguity = `landing cell ${cellKey(landed[0]!)} reads "${itemNameOf(text)}", not ${entry.name}`;
          }
        }
        if (!ambiguity) {
          await this.harness.checkpoint(`verify ${entry.name}`);
          const asking = await this.readAskingPrice({ x: landed[0]!.x, y: landed[0]!.y });
          if (asking && priceMatches(asking, entry.price)) {
            recordListed(fingerprint, entry, asking, landed[0]!);
            report.push(
              `${entry.name}: listed at ${cellKey(landed[0]!)}${entry.stack ? ` ${entry.stack.label}` : ""} — tooltip reads "${asking.raw}"`,
            );
          } else {
            failed += 1;
            report.push(
              `${entry.name}: in merchant tab "${tabLabel}" at ${cellKey(landed[0]!)} but the tooltip reads ${asking ? `"${asking.raw}"` : "no asking price"} — expected ${entry.price.amount}x ${entry.price.currency}; fix by hand`,
            );
          }
          continue;
        }
        this.log(`  · ${entry.name}: targeted verification inconclusive (${ambiguity}) — whole-tab rescan after the batch`);
      }
      const intent = wanted.get(fingerprint);
      if (intent) intent.count += 1;
      else wanted.set(fingerprint, { price: entry.price, name: entry.name, itemClass: entry.itemClass, count: 1 });
    }
    if (wanted.size === 0) {
      this.appendEvents(events);
      return { listed, failed, report };
    }

    // Whole-tab fallback: rescan, then verify every pending listing by its
    // tooltip. Copies of one fingerprint are indistinguishable in the tab
    // (a bucket tab prices them all alike), so up to the pending count of
    // matching items are hovered, whichever cells they sit in.
    const postScan = await this.sorter.scanTab(source, { navigate: false });
    if (!postScan.ok) throw new Error(`shop-scan-failed:${postScan.reason}`);
    const fallbackVerified = new Map<string, number>();
    for (const item of postScan.modelItems) {
      const fingerprint = fingerprintOf(item.text);
      const intent = wanted.get(fingerprint);
      if (!intent) continue;
      if ((fallbackVerified.get(fingerprint) ?? 0) >= intent.count) continue;
      await this.harness.checkpoint(`verify ${intent.name}`);
      const asking = await this.readAskingPrice({ x: item.cells[0]!.x, y: item.cells[0]!.y });
      if (asking && priceMatches(asking, intent.price)) {
        recordListed(fingerprint, intent, asking, item.cells[0]!);
        fallbackVerified.set(fingerprint, (fallbackVerified.get(fingerprint) ?? 0) + 1);
        report.push(`${intent.name}: listed — tooltip reads "${asking.raw}"`);
      } else {
        failed += 1;
        report.push(
          `${intent.name}: in merchant tab "${tabLabel}" but the tooltip reads ${asking ? `"${asking.raw}"` : "no asking price"} — expected ${intent.price.amount}x ${intent.price.currency}; fix by hand`,
        );
      }
    }
    for (const [fingerprint, intent] of wanted) {
      const missing = intent.count - (fallbackVerified.get(fingerprint) ?? 0);
      if (missing > 0 && !report.some((line) => line.startsWith(`${intent.name}: in merchant tab`))) {
        failed += missing;
        report.push(`${intent.name}: left the bag but was not found in merchant tab "${tabLabel}" — check by hand`);
      }
    }
    this.appendEvents(events);
    return { listed, failed, report };
  }

  /**
   * First-use teach (step mode, validation workflow step 3): the user clicks
   * each control; offsets are stored relative to the OCR anchor so the
   * dialog can move freely between opens. Their clicks act in-game, so the
   * dialog is left however their last click left it — the caller reopens.
   */
  private async teachDialog(
    title: { line: OcrLine; pattern: RegExp },
    row: { line: OcrLine; pattern: RegExp },
  ): Promise<ShopDialogCalibration | undefined> {
    const rowCentre = anchorCentre(row.line);
    this.log(
      `  · teaching the price dialog (row anchor "${row.line.text}" centred ${rowCentre.x},${rowCentre.y}) — follow the on-screen prompts`,
    );
    const amount = await this.harness.captureCorrection(
      "shop dialog TEACH: click the AMOUNT field",
      rowCentre,
    );
    if (!amount?.corrected) return undefined;
    const confirm = await this.harness.captureCorrection(
      "shop dialog TEACH: click the LIST ITEM button",
      rowCentre,
    );
    if (!confirm?.corrected) return undefined;
    const calibration: ShopDialogCalibration = {
      version: 2,
      taughtAt: this.now().toISOString(),
      titlePattern: title.pattern.source,
      rowPattern: row.pattern.source,
      offsets: {
        amount: { dx: amount.corrected.x - rowCentre.x, dy: amount.corrected.y - rowCentre.y },
        confirm: { dx: confirm.corrected.x - rowCentre.x, dy: confirm.corrected.y - rowCentre.y },
      },
      currencyOptions: {},
    };
    this.saveDialogCalibration(calibration);
    this.log(`  · price-dialog offsets saved to ${this.dialogFile}`);
    return calibration;
  }

  private async teachCurrency(
    calibration: ShopDialogCalibration,
    row: OcrLine,
    currency: string,
  ): Promise<ShopDialogCalibration | undefined> {
    const rowCentre = anchorCentre(row);
    if (!calibration.offsets.currencyOpen) {
      const open = await this.harness.captureCorrection(
        "shop dialog TEACH: click the CURRENCY selector",
        rowCentre,
      );
      if (!open?.corrected) return undefined;
      calibration.offsets.currencyOpen = {
        dx: open.corrected.x - rowCentre.x,
        dy: open.corrected.y - rowCentre.y,
      };
    }
    const option = await this.harness.captureCorrection(
      `shop dialog TEACH: click the ${currency.toUpperCase()} option`,
      rowCentre,
    );
    if (!option?.corrected) return undefined;
    calibration.currencyOptions[currency] = {
      dx: option.corrected.x - rowCentre.x,
      dy: option.corrected.y - rowCentre.y,
    };
    this.saveDialogCalibration(calibration);
    return calibration;
  }

  /** Close a lingering dialog without saving: the taught close cross, else Esc. */
  private async closeDialogBestEffort(
    calibration: ShopDialogCalibration | undefined,
    titleCentre: { x: number; y: number } | undefined,
  ): Promise<void> {
    if (calibration?.closeFromTitle && titleCentre) {
      await this.host.send({
        op: "click",
        x: titleCentre.x + calibration.closeFromTitle.dx,
        y: titleCentre.y + calibration.closeFromTitle.dy,
      });
    } else {
      await this.host.send({ op: "hotkey", keys: "esc" }).catch(() => undefined);
    }
    await this.park();
    await this.harness.sleep(350, false);
  }

  // -------------------------------------------------------------------------
  // Phase 2: identify, appraise, and list new items from the bag
  // -------------------------------------------------------------------------

  /**
   * Plan phase 2 (no writes): read the bag, appraise every item, fetch comps
   * for the confident ones, gate, rank, and fit into free shop cells (with
   * reported evictions). Everything below threshold is reported as a Review
   * route — never auto-listed.
   */
  async planBagListings(freeCells: number, state: readonly ActiveListing[], options: {
    compsLimit?: number;
  } = {}): Promise<{
    candidates: ReturnType<typeof rankListingCandidates>;
    admitted: ReturnType<typeof rankListingCandidates>;
    evictions: ActiveListing[];
    bagItems: Map<string, IdentifiedItem>;
    report: string[];
  }> {
    const config = this.options.config;
    if (!this.options.evaluate) throw new Error("shop-list-needs-evaluator");
    const report: string[] = [];
    const at = this.now().toISOString();
    let compsBudget = compsBudgetFor(options.compsLimit, 15);

    const { items, unread } = await this.sorter.identifyBagItems();
    if (unread.length > 0) report.push(`${unread.length} bag cell(s) unreadable — left alone`);
    const bagItems = new Map<string, IdentifiedItem>();
    const candidates: ListingCandidate[] = [];
    for (const item of items) {
      const verdict = this.options.evaluate(item.text);
      const appraisal = verdict.appraisal;
      if (!appraisal) {
        report.push(`${item.itemClass ?? "item"} at ${item.cells[0]!.row},${item.cells[0]!.col}: no appraisal — skipped`);
        continue;
      }
      if (appraisal.confidence < config.minListConfidence) {
        report.push(
          `hold (Review): ${item.itemClass ?? "item"} — confidence ${appraisal.confidence} < ${config.minListConfidence}`,
        );
        continue;
      }
      let comps: CompsSummary | undefined;
      if (this.options.comps && compsBudget > 0) {
        compsBudget -= 1;
        const compsResult = await this.options.comps(item.text);
        if (compsResult === "rate-limited") compsBudget = 0;
        comps = compsResult === "rate-limited" ? undefined : compsResult;
      }
      const gate = listingGate({
        appraisal,
        tier: verdict.tier,
        ...(comps ? { comps } : {}),
        config,
        at,
        ...(this.table ? { priceTable: this.table } : {}),
      });
      if (!gate.ok) {
        report.push(`hold (Review): ${item.itemClass ?? "item"} — ${gate.reason}`);
        continue;
      }
      const fingerprint = `${item.cells[0]!.row},${item.cells[0]!.col}`;
      bagItems.set(fingerprint, item);
      candidates.push({
        fingerprint,
        name: item.text.split(/\r?\n/).find((line) => line.trim() && !/^(Item Class|Rarity):/i.test(line)) ?? "item",
        itemClass: item.itemClass ?? "Unknown",
        cellCount: item.cells.length,
        suggestion: gate.suggestion,
        ...(gate.needsConfirmation ? { needsConfirmation: gate.needsConfirmation } : {}),
      });
      if (gate.needsConfirmation) {
        report.push(`NEEDS CONFIRMATION: ${item.itemClass ?? "item"} — ${gate.needsConfirmation}`);
      }
    }
    const stats = salesStats(this.loadLedger());
    const autoListable = candidates.filter((candidate) => !candidate.needsConfirmation);
    const ranked = rankListingCandidates(autoListable, stats);
    const evictionPlan = planEvictions({
      active: state,
      candidates: ranked,
      freeCells,
      config,
      nowMs: this.now().getTime(),
    });
    report.push(...evictionPlan.report);
    return {
      candidates: rankListingCandidates(candidates, stats),
      admitted: evictionPlan.admitted,
      evictions: evictionPlan.evict,
      bagItems,
      report,
    };
  }

  /**
   * Execute phase 2 (live): each admitted candidate is ctrl-clicked from the
   * bag into the merchant tab and priced in the dialog that pops up; the
   * tab is then rescanned and every listing verified by its tooltip before
   * the ledger records it (see listBagItems).
   */
  async applyBagListings(
    admitted: ReadonlyArray<{ fingerprint: string; name: string; itemClass: string; suggestion: PriceSuggestion }>,
    bagItems: ReadonlyMap<string, IdentifiedItem>,
  ): Promise<{ listed: number; failed: number }> {
    if (this.options.dryRun) throw new Error("shop-apply-refused-in-dry-run");
    const entries = admitted.flatMap((entry) => {
      const item = bagItems.get(entry.fingerprint);
      return item
        ? [{ item, price: entry.suggestion.display, name: entry.name, itemClass: entry.itemClass }]
        : [];
    });
    const result = await this.listBagItems(entries, this.options.config.shopTab);
    for (const line of result.report) this.log(`  · ${line}`);
    return { listed: result.listed, failed: result.failed };
  }

  // -------------------------------------------------------------------------
  // Bucket ladder: move stale app listings to a cheaper bucket tab
  // -------------------------------------------------------------------------

  /**
   * Execute a bucket-ladder plan, one move at a time: select the source
   * bucket, find the listing by fingerprint (Ctrl+C), DELIST it, then list
   * it into the target bucket through the ordinary bag path.
   *
   * The DELIST gesture on a merchant tab was NEVER demonstrated (the handoff
   * lists it as unknown). This tries a ctrl-click on the listed item and
   * believes only a bag Ctrl+C read of the same fingerprint. Anything else
   * — the SET ITEM PRICE dialog opening instead, no bag growth, another
   * item in the new cell — is treated as "the item may be on the cursor":
   * one click back on the same cell to put it down, a screenshot, and the
   * run stops. Ledger: "delisted" (app, verified) then "listed".
   */
  async applyBucketLadder(
    plan: BucketLadderPlan,
    options: {
      /** Per-move comps check at apply time (the plan had no item text). */
      compsFor?: (itemText: string) => Promise<PriceSuggestion | PriceRefusal | undefined>;
      buckets?: readonly BucketTab[];
    } = {},
  ): Promise<{ moved: number; skipped: number; failed: number; report: string[] }> {
    if (this.options.dryRun) throw new Error("shop-apply-refused-in-dry-run");
    const report: string[] = [];
    let moved = 0;
    let skipped = 0;
    let failed = 0;
    if (plan.moves.length === 0) return { moved, skipped, failed, report };
    const config = this.options.config;
    const fingerprintOf = (text: string): string => parseItemText(text).fingerprint;
    // Group by source bucket so one tab select serves its moves.
    const bySource = new Map<string, BucketLadderMove[]>();
    for (const move of plan.moves) {
      bySource.set(move.from.label, [...(bySource.get(move.from.label) ?? []), move]);
    }
    for (const [fromLabel, moves] of bySource) {
      for (const move of moves) {
        const listing = move.listing;
        const name = listing.name;
        // Every move re-selects its source: the previous move ended on the
        // target bucket (listBagItems selects it).
        if (!(await this.ensureMerchantOpen())) throw new Error("merchant-panel-not-open");
        if (!(await this.selectMerchantTab(fromLabel))) throw new Error("merchant-tab-unreachable");
        await this.requirePanel("merchant");
        await this.requirePanel("inventory");
        const scan = await this.sorter.scanTab({ label: fromLabel, occurrence: 0, shop: true }, { navigate: false });
        if (!scan.ok) throw new Error(`shop-scan-failed:${scan.reason}`);
        const item = scan.modelItems.find((entry) => fingerprintOf(entry.text) === listing.fingerprint);
        if (!item) {
          skipped += 1;
          report.push(`${name}: not found in ${fromLabel} — ledger stale? (a --record scan reconciles it)`);
          continue;
        }
        const cell = item.cells[0]!;
        const asking = await this.readAskingPrice({ x: cell.x, y: cell.y });
        if (asking?.locked) {
          skipped += 1;
          report.push(`${name}: priced recently — the game's cooldown still locks it [cooldown]`);
          continue;
        }
        if (asking && !priceMatches(asking, move.from)) {
          skipped += 1;
          report.push(`${name}: tooltip reads "${asking.raw}", not the ${fromLabel} price — repriced by hand? left alone`);
          continue;
        }
        if (options.compsFor) {
          const suggestion = await options.compsFor(item.text);
          const rerun = planBucketLadder({
            listings: [listing],
            buckets: options.buckets ?? [move.from, move.to],
            config,
            nowMs: this.now().getTime(),
            compsFor: () => suggestion,
          });
          if (rerun.moves.length === 0) {
            skipped += 1;
            report.push(`${name}: ${rerun.holds[0]?.reasons[0] ?? "held after the comps check"}`);
            continue;
          }
        }
        // --- DELIST (unverified gesture: ctrl-click, believed only via the bag) ---
        const bagBefore = await this.sorter.bagCellsNow();
        if (bagBefore.length + item.cells.length > BAG_CELL_CAPACITY) {
          skipped += 1;
          report.push(`${name}: bag has no room for it — empty the bag first`);
          continue;
        }
        const sent = await this.harness.burst([cell], {
          found: item.cells,
          cellW: 70,
          cellH: 70,
          label: `ladder ${fromLabel} → ${move.to.label}: ctrl-click ${name} back to the bag (DELIST — unverified gesture)`,
        });
        if (sent === 0) {
          skipped += 1;
          report.push(`${name}: delist click rejected — skipped`);
          continue;
        }
        await this.harness.sleep(800, false);
        // A ctrl-click on a listed item could open the price dialog instead.
        const lines = await this.kit.settledOcr(3);
        if (this.findDialogAnchors(lines)) {
          await this.closeDialogBestEffort(this.loadDialogCalibration(), undefined);
          throw await this.captureAndStop(
            "ladder-delist",
            `ctrl-click on ${name} opened the SET ITEM PRICE dialog instead of delisting — the delist gesture is something else; nothing moved`,
          );
        }
        const bagAfter = await this.sorter.bagCellsNow();
        const known = new Set(bagBefore.map((entry) => `${entry.row},${entry.col}`));
        const landed = bagAfter.filter((entry) => !known.has(`${entry.row},${entry.col}`));
        let bagText = landed.length > 0 ? await this.sorter.copyAt(landed[0]!.x, landed[0]!.y) : "";
        if (landed.length === 0 || !bagText || fingerprintOf(bagText) !== listing.fingerprint) {
          const seen =
            landed.length === 0
              ? `the bag did not grow after ctrl-clicking ${name}`
              : `bag cell ${landed[0]!.row},${landed[0]!.col} reads ${bagText ? `"${itemNameOf(bagText)}"` : "nothing"} after ctrl-clicking ${name}`;
          // Only click the cell when the item can actually be on the cursor:
          // if Ctrl+C still reads it IN its cell, nothing moved and a plain
          // click there would pick it up — the very hazard the click exists
          // to undo. An empty cell means it left without reaching the bag.
          const stillThere = await this.sorter.copyAt(cell.x, cell.y);
          if (stillThere && fingerprintOf(stillThere) === listing.fingerprint) {
            throw await this.captureAndStop(
              "ladder-delist",
              `${seen} — it is still in ${fromLabel} ${cell.row},${cell.col} (Ctrl+C), so the ctrl-click did nothing; the delist gesture is something else. Nothing moved`,
            );
          }
          await this.harness.click(cell.x, cell.y, `put ${name} back (delist unverified)`);
          await this.park();
          await this.harness.sleep(600, false);
          throw await this.captureAndStop(
            "ladder-delist",
            `${seen} and its cell copies empty — clicked the cell once to put a held item back; check the game (a price dialog may have opened)`,
          );
        }
        bagText = bagText || item.text;
        this.appendEvents([
          {
            at: this.now().toISOString(),
            kind: "delisted",
            fingerprint: listing.fingerprint,
            name,
            itemClass: listing.itemClass,
            count: 1,
            by: "app",
            certainty: "verified",
            ...(listing.price ? { previousPrice: listing.price } : {}),
            cell: { row: cell.row, col: cell.col },
            reason: `bucket ladder: ${move.reasons[0] ?? `${fromLabel} → ${move.to.label}`}`,
          },
        ]);
        report.push(`${name}: delisted from ${fromLabel} → bag ${landed[0]!.row},${landed[0]!.col} (verified by Ctrl+C)`);
        // --- RELIST into the target bucket via the ordinary bag path ---
        const bagItem: IdentifiedItem = { dest: item.dest, itemClass: item.itemClass, text: bagText, cells: landed };
        const price: DenominatedPrice = { amount: move.to.amount, currency: move.to.currency, exalted: move.to.exalted };
        const result = await this.listBagItems(
          [{ item: bagItem, price, name, itemClass: listing.itemClass }],
          move.to.label,
        );
        report.push(...result.report.map((line) => `[${move.to.label}] ${line}`));
        if (result.listed > 0) moved += 1;
        else failed += 1;
      }
    }
    return { moved, skipped, failed, report };
  }

  // -------------------------------------------------------------------------
  // Review tab as a listing source (shop.json sources: "review")
  // -------------------------------------------------------------------------

  /**
   * Stage the stash Review tab into the bag: open the stash (the sorter's
   * session), index the Review tab, withdraw as many items as the bag's
   * free cells hold (verified-serial), then CLOSE the stash the way the
   * vendor step does — Escape, verified by the title band, never a guessed
   * key — because the Merchant panel cannot open while the stash shows.
   * Dry-run indexes and reports; the stash is still closed afterwards so the
   * bag plan that follows can open the Merchant.
   */
  async stageReviewItems(
    reviewTab: string,
  ): Promise<{ chosen: IdentifiedItem[]; withdrawn: IdentifiedItem[]; report: string[] }> {
    const report: string[] = [];
    await this.sorter.ensureSession();
    const scan = await this.sorter.scanTab({ label: reviewTab, occurrence: 0 });
    if (!scan.ok) throw new Error(`review-tab-unreachable:${scan.reason}`);
    const bag = await this.sorter.bagCellsNow();
    let free = Math.max(0, BAG_CELL_CAPACITY - bag.length);
    const chosen: IdentifiedItem[] = [];
    for (const item of scan.modelItems) {
      if (item.cells.length > free) continue;
      chosen.push(item);
      free -= item.cells.length;
    }
    report.push(
      `Review tab "${reviewTab}": ${scan.modelItems.length} item(s)` +
        (scan.unread.length > 0 ? `, ${scan.unread.length} unread cell(s)` : "") +
        ` — ${chosen.length} fit the bag's ${BAG_CELL_CAPACITY - bag.length} free cell(s)`,
    );
    for (const item of chosen) {
      report.push(`${this.options.dryRun ? "would withdraw" : "withdraw"}: ${itemNameOf(item.text)} (${item.itemClass ?? "?"}, ${item.cells.length} cell(s))`);
    }
    const withdrawn = this.options.dryRun || chosen.length === 0
      ? []
      : await this.sorter.withdrawItemsSerial(chosen, reviewTab);
    if (!this.options.dryRun && withdrawn.length < chosen.length) {
      report.push(`${chosen.length - withdrawn.length} withdraw(s) did not commit — left in ${reviewTab}`);
    }
    await this.closeStashPanel();
    return { chosen, withdrawn, report };
  }

  /**
   * Close the stash panel with Escape, verified by the title band each
   * time (the vendor step's pattern). A panel that survives three verified
   * presses is an unknown state — capture and stop rather than press on.
   */
  private async closeStashPanel(): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const panels = await panelsViaOcr(this.host);
      if (!panels.stash) return;
      await this.host.send({ op: "focus" });
      await this.harness.sleep(200, false);
      await this.host.send({ op: "hotkey", keys: "escape" });
      await this.park();
      await this.harness.sleep(600, false);
    }
    if ((await panelsViaOcr(this.host)).stash) {
      throw await this.captureAndStop("close-stash", "the stash panel did not close after three Escape presses");
    }
  }
}
