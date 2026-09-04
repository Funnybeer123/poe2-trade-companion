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
import type { IdentifiedItem } from "../core/gearSort.js";
import { parseItemText } from "../core/parseItem.js";
import { screenForLookup, summarizeScreen } from "../core/lookupScreen.js";
import type { SortHarness } from "./sortHarness.js";
import { STRIP_ROWS, pickExact, type StashTabKit, type OcrLine, type StripEntry } from "./stashTabKit.js";
import { copyPoints, findOcrLines, lineCenter, panelsViaOcr } from "./bagKit.js";
import type { WinReply } from "./winHost.js";
import {
  bucketFor,
  bucketTabs,
  buildShopSnapshot,
  deriveShopState,
  noteExalted,
  parseListingEvents,
  priceFromTabLabel,
  reconcileShopScan,
  type BucketTab,
  type ActiveListing,
  type ListingEvent,
  type ListingPrice,
  type ShopCell,
  type ShopConfig,
  type ShopSnapshot,
  type ShopSnapshotItem,
} from "../core/shopListings.js";
import {
  isPriceRefusal,
  listingGate,
  planEvictions,
  rankListingCandidates,
  repriceDecision,
  salesStats,
  suggestListingPrice,
  type DenominatedPrice,
  type ListingCandidate,
  type PriceRefusal,
  type PriceSuggestion,
} from "../core/shopPricing.js";
import { tradeCurrencyToOrb, type CompsSummary } from "../core/tradeComps.js";
import type { PriceTable } from "../core/priceTable.js";
import type { TierVerdict } from "../core/valueTiers.js";

interface ShopHost {
  send(payload: Record<string, unknown>): Promise<WinReply>;
}

const PARK = { x: 660, y: 1900 } as const;

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
}

export class ShopKeeper {
  private readonly log: (line: string) => void;

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

  private get outDir(): string {
    return path.join(this.options.root, "artifacts", "tab-admin");
  }

  private get ledgerFile(): string {
    return path.join(this.outDir, "listings.jsonl");
  }

  private get dialogFile(): string {
    return path.join(this.outDir, "shop-dialog.json");
  }

  /**
   * The one merchant tab this feature may touch, as an index source. The
   * Merchant panel's grid uses the FOLDER-row geometry (12x12, same bounds
   * as a folder stash tab) and its navigation is the panel's own strip —
   * never stash navigation, so scanTab runs with navigate:false.
   */
  source(): SourceTab {
    return { label: this.options.config.shopTab, occurrence: 0 };
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
    const buckets = bucketTabs(labels, this.options.priceTable);
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
        ...(this.options.priceTable ? { priceTable: this.options.priceTable } : {}),
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
    options: { record: boolean; knownElsewhere?: ReadonlySet<string> } = { record: false },
  ): { state: ActiveListing[]; events: ListingEvent[]; report: string[] } {
    const ledger = this.loadLedger();
    const prior = deriveShopState(ledger);
    const { events, report } = reconcileShopScan({
      state: prior,
      snapshot,
      ...(options.knownElsewhere ? { knownElsewhere: options.knownElsewhere } : {}),
      ...(this.options.priceTable ? { priceTable: this.options.priceTable } : {}),
    });
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
    let compsBudget = options.compsLimit ?? 20;

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
        ...(this.options.priceTable ? { priceTable: this.options.priceTable } : {}),
      });
    };

    for (const item of snapshot.items) {
      const listing = byPrint.get(item.fingerprint);
      if (!listing) continue; // reconcile handles unknown items
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
        ...(this.options.priceTable ? { priceTable: this.options.priceTable } : {}),
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

  /** Right-click with the marker overlay (mirrors StashTabKit.pointer). */
  private async rightClick(x: number, y: number, why: string): Promise<void> {
    await this.harness.checkpoint(`before right-click: ${why}`);
    await this.host
      .send({
        op: "marks",
        rects: [{ x: Math.round(x) - 22, y: Math.round(y) - 22, w: 44, h: 44, kind: "click", label: why }],
      })
      .catch(() => undefined);
    await this.harness.sleep(400, false);
    await this.host.send({ op: "rightclick", x: Math.round(x), y: Math.round(y) });
    await this.host.send({ op: "hidemark" }).catch(() => undefined);
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
      if (outcome.reason === "dialog-not-taught" || outcome.reason === "currency-not-taught") {
        return outcome; // teaching is a user action, not a retry
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
    await this.rightClick(point.x, point.y, `price dialog: ${name}`);
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
            this.options.priceTable,
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
        this.options.priceTable,
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
    this.appendEvents(events);
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
    let compsBudget = options.compsLimit ?? 15;
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
      if (decision.route === "local-price" && appraisal?.estimatedValue) {
        estimate = appraisal.estimatedValue.amount;
        basis = "price table";
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
            ...(this.options.priceTable ? { priceTable: this.options.priceTable } : {}),
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
      const lines = await findOcrLines(this.host, true);
      const plate = lines.find((line) => /^zelina$/i.test(line.text.trim()));
      if (!plate) {
        report.push("ZELINA's nameplate is not on screen — stand near her in the hideout");
        return { sold: 0, failed: entries.length, report };
      }
      const point = lineCenter(plate, 70);
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
        entries.map((entry) => ({ item: entry.item, price, name: entry.name, itemClass: entry.itemClass })),
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
   * the dialog, confirm the bag cell emptied, then rescan the tab and read
   * every new listing's tooltip before recording it. Nothing is written to
   * the ledger that the tooltip did not confirm.
   */
  async listBagItems(
    entries: ReadonlyArray<{
      item: IdentifiedItem;
      price: DenominatedPrice;
      name: string;
      itemClass: string;
    }>,
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

    const wanted = new Map<string, { price: DenominatedPrice; name: string; itemClass: string; count: number }>();
    for (const [index, entry] of entries.entries()) {
      const cell = entry.item.cells[0]!;
      const fingerprint = fingerprintOf(entry.item.text);
      const sent = await this.harness.burst([cell], {
        cellW: 70,
        cellH: 70,
        label: `list ${index + 1}/${entries.length}: ctrl-click ${entry.name} → merchant tab "${tabLabel}"`,
      });
      if (sent === 0) {
        failed += 1;
        report.push(`${entry.name}: ctrl-click rejected — skipped`);
        continue;
      }
      await this.harness.sleep(800, false);
      const filled = await this.fillOpenPriceDialog(entry.price, entry.name);
      if (!filled.ok) {
        failed += 1;
        report.push(`${entry.name}: price dialog failed (${filled.reason}) — check whether it moved`);
        continue;
      }
      await this.harness.sleep(500, false);
      const bagNow = await this.sorter.bagCellsNow();
      if (bagNow.some((other) => other.row === cell.row && other.col === cell.col)) {
        failed += 1;
        report.push(`${entry.name}: still in the bag after LIST ITEM — not listed`);
        continue;
      }
      const intent = wanted.get(fingerprint);
      if (intent) intent.count += 1;
      else wanted.set(fingerprint, { price: entry.price, name: entry.name, itemClass: entry.itemClass, count: 1 });
    }
    if (wanted.size === 0) return { listed, failed, report };

    // Verify every new listing by its tooltip, then record it.
    const postScan = await this.sorter.scanTab(source, { navigate: false });
    if (!postScan.ok) throw new Error(`shop-scan-failed:${postScan.reason}`);
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
    for (const item of postScan.modelItems) {
      const fingerprint = fingerprintOf(item.text);
      const intent = wanted.get(fingerprint);
      if (!intent) continue;
      const alreadyThere = preCounts.get(fingerprint) ?? 0;
      const verified = verifiedCounts.get(fingerprint) ?? 0;
      if (alreadyThere + verified >= (alreadyThere + intent.count)) continue;
      await this.harness.checkpoint(`verify ${intent.name}`);
      const asking = await this.readAskingPrice({ x: item.cells[0]!.x, y: item.cells[0]!.y });
      if (asking && priceMatches(asking, intent.price)) {
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
          this.options.priceTable,
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
          cell: { row: item.cells[0]!.row, col: item.cells[0]!.col },
          reason: "listed from the bag",
        });
        report.push(`${intent.name}: listed — tooltip reads "${asking.raw}"`);
      } else {
        failed += 1;
        report.push(
          `${intent.name}: in merchant tab "${tabLabel}" but the tooltip reads ${asking ? `"${asking.raw}"` : "no asking price"} — expected ${intent.price.amount}x ${intent.price.currency}; fix by hand`,
        );
      }
    }
    for (const [fingerprint, intent] of wanted) {
      const missing = intent.count - (verifiedCounts.get(fingerprint) ?? 0);
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
    let compsBudget = options.compsLimit ?? 15;

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
        ...(this.options.priceTable ? { priceTable: this.options.priceTable } : {}),
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
}
