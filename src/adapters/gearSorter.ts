/**
 * Gear sorter state machine: redistribute items between the Gear folder's
 * per-slot tabs so each tab holds only its class.
 *
 * Structure follows the rework handoff (docs/HANDOFF-sort-rework.md) with the
 * performance overhaul (docs/HANDOFF-sort-performance.md) applied:
 *
 * - `ensureSession` — unstick the mouse, get stash+inventory open with
 *   bounded recovery, open the Gear folder's strip row once; every tab hop
 *   then goes through the FOLDER side list (its own chevron, its own rows).
 *   The horizontal strip is never used for tab addressing (clipped labels,
 *   merged labels, stalling scroll arrows, phantom entries).
 * - `cleanTab` — identify every occupied cell by Ctrl+C ground truth,
 *   withdraw the foreigners a bag-load at a time, file each by its own text.
 *   Re-sweeps are INCREMENTAL (only cells that could have changed), hovers
 *   are batched, and pixel signatures may skip continuation cells of one
 *   sprite — always verified against the class footprint plus a re-read.
 * - Navigation caches list rows (they never move) and replaces fixed sleeps
 *   with pixel change-detection (`pixwait` host op); OCR runs only when the
 *   cheap paths cannot prove state.
 * - Every click and burst goes through the SortHarness (bullseye + label,
 *   step mode, corrections, overlay hygiene); there are no bare click sends.
 * - Round decisions come from src/core/gearSort.ts so they are unit-tested.
 */
import os from "node:os";
import path from "node:path";
import { mkdirSync } from "node:fs";
import { StashTabKit, type TabListRow } from "./stashTabKit.js";
import { SortHarness, SortStop } from "./sortHarness.js";
import { labelsEqualFolded, labelsSimilar, normalizeTabLabel } from "../core/tabList.js";
import { isDrainableRemoveOnlyLabel, isRemoveOnlyTabLabel } from "../core/stashTabAdmin.js";
import { brightestCellPoint, regionChangedFraction } from "../core/itemSprites.js";
import { loadProfile } from "../core/calibrationStore.js";
import { toScreenBox, type CalibrationProfile } from "../core/calibrationProfile.js";
import {
  CLICK_SURFACES,
  GEAR_TAB_NAMES,
  canonicalTTabLabel,
  clickRefusal,
  foreignItemsFor,
  groupIdentifiedCells,
  guildDestForItem,
  packTripByDest,
  withdrawObservation,
  type GridCell,
  type IdentifiedItem,
} from "../core/gearSort.js";
import {
  DEFAULT_MIN_DETOUR_CONFIDENCE,
  findRecordFor,
  isTriageTabLabel,
  routeIdentifiedItem,
  type RoutedItem,
  type SortTriageConfig,
} from "../core/sortTriage.js";
import { inventoryRecordsFor } from "../core/inventoryLedger.js";
import { StashPerception } from "./gearSorter/stashPerception.js";
import { TabNavigation } from "./gearSorter/tabNavigation.js";
import { ItemIdentification } from "./gearSorter/itemIdentification.js";
import { Transfers } from "./gearSorter/transfers.js";
import { PARK, GUILD_PACE } from "./gearSorter/context.js";
import type {
  SortHost,
  RawFrame,
  SourceTab,
  TabScanResult,
  GearSorterOptions,
  SorterContext,
} from "./gearSorter/context.js";

export type {
  SourceTab,
  TabIndex,
  TabScanResult,
  GearSorterTriageOptions,
  GearSorterOptions,
} from "./gearSorter/context.js";

export class GearSorter {
  private readonly debugDir: string;

  private currentStep = "starting";

  /** The last row this sorter selected (label#occurrence), for the case
   * where a tab's own highlight makes its row unreadable while ACTIVE. */
  private lastSelected: string | undefined;

  /**
   * Bag cells ("row,col") that survived deposit attempts in two DIFFERENT
   * tabs. Ctrl-click routes an item with a stash affinity to its affinity
   * tab regardless of the open tab — a full Unique tab makes every unique
   * undepositable ANYWHERE, and re-clicking it just spams "not enough
   * space" toasts (watched live). Stuck cells are never clicked again; they
   * ride in the bag and are reported at the end.
   */
  private readonly undepositableBag = new Set<string>();

  /** Destinations observed FULL this session (their overflow already went to
   * T tabs). Top-level sources skip withdrawing items bound for these —
   * pulling them out would only churn them straight back to a T tab. */
  private readonly fullDests = new Set<string>();

  /** Last stash geometry that perceived sanely — the folder's tabs share
   * panel bounds, so it doubles as a fallback when perception goes blind on
   * one tab (the Boots tab returned NO region/grid on every frame). */
  private lastGoodStashGeometry:
    | { region: { x: number; y: number; w: number; h: number }; cols: number; rows: number }
    | undefined;

  private readonly log: (line: string) => void;

  /** Scratch dir for the per-frame capture BMPs (24MB each, created and
   * deleted hundreds of times per run) — the system temp dir, NOT the
   * OneDrive-synced repo, whose sync watcher taxes rapid create/delete. */
  private readonly captureScratchDir: string;

  private readonly ctx: SorterContext;
  private readonly perception: StashPerception;
  private readonly navigation: TabNavigation;
  private readonly identification: ItemIdentification;
  private readonly transfers: Transfers;

  constructor(
    private readonly host: SortHost,
    private readonly harness: SortHarness,
    private readonly kit: StashTabKit,
    private readonly options: GearSorterOptions,
  ) {
    this.debugDir = path.join(options.root, "artifacts", "tab-admin", "debug");
    mkdirSync(this.debugDir, { recursive: true });
    this.captureScratchDir = path.join(os.tmpdir(), "poe2-sort-captures");
    mkdirSync(this.captureScratchDir, { recursive: true });
    this.log = options.log ?? ((line) => console.log(line));
    this.runId = options.runId ?? `run-${Date.now().toString(36)}`;
    this.ctx = GearSorter.contextFor(this);
    this.perception = new StashPerception(this.ctx);
    this.navigation = new TabNavigation(this.ctx);
    this.identification = new ItemIdentification(this.ctx);
    this.transfers = new Transfers(this.ctx);
  }

  /**
   * The modules' view of one sorter: fixed collaborators, the shared
   * helpers, accessors over the state more than one module touches, and
   * the modules themselves (constructed right after this in the
   * constructor, hence the lazy getters).
   */
  private static contextFor(sorter: GearSorter): SorterContext {
    return {
      host: sorter.host,
      harness: sorter.harness,
      kit: sorter.kit,
      options: sorter.options,
      log: sorter.log,
      debugDir: sorter.debugDir,
      captureScratchDir: sorter.captureScratchDir,
      get guildChest() {
        return sorter.guildChest;
      },
      get profile() {
        return sorter.profile;
      },
      titleMatchesChest: (text) => sorter.titleMatchesChest(text),
      step: (text) => sorter.step(text),
      park: () => sorter.park(),
      surfaceClick: (x, y, surface, why) => sorter.surfaceClick(x, y, surface, why),
      get lastGoodStashGeometry() {
        return sorter.lastGoodStashGeometry;
      },
      set lastGoodStashGeometry(value) {
        sorter.lastGoodStashGeometry = value;
      },
      get lastStashProofAt() {
        return sorter.lastStashProofAt;
      },
      set lastStashProofAt(value) {
        sorter.lastStashProofAt = value;
      },
      get lastSelected() {
        return sorter.lastSelected;
      },
      set lastSelected(value) {
        sorter.lastSelected = value;
      },
      get folderRowsCache() {
        return sorter.folderRowsCache;
      },
      set folderRowsCache(value) {
        sorter.folderRowsCache = value;
      },
      knownTopLabels: sorter.knownTopLabels,
      undepositableBag: sorter.undepositableBag,
      fullDests: sorter.fullDests,
      get gridCalibration() {
        return sorter.gridCalibration;
      },
      set gridCalibration(value) {
        sorter.gridCalibration = value;
      },
      recordObservations: (items, location, partial) => sorter.recordObservations(items, location, partial),
      distributeBag: (context) => sorter.distributeBag(context),
      get perception() {
        return sorter.perception;
      },
      get navigation() {
        return sorter.navigation;
      },
      get identification() {
        return sorter.identification;
      },
      get transfers() {
        return sorter.transfers;
      },
    };
  }

  get lastStep(): string {
    return this.currentStep;
  }

  private get guildChest(): boolean {
    return this.options.chest === "guild";
  }

  /**
   * Chest-specific panel-title match, specific in BOTH directions: "Guild
   * Stash" contains "stash", so the personal check must reject it or a
   * guild panel left open would pass for the personal stash (and vice
   * versa a bare /stash/ guild check would accept the personal panel).
   */
  private titleMatchesChest(text: string): boolean {
    return this.guildChest
      ? /guild/i.test(text) && /stash/i.test(text)
      : /stash/i.test(text) && !/guild/i.test(text);
  }

  private async step(text: string): Promise<void> {
    this.currentStep = text;
    this.log(`  · ${text}`);
    await this.harness.checkpoint(text);
  }

  /** Calibration profile, loaded once — captureFrame used to re-read the
   * JSON from disk on every single frame. */
  private profileCache: CalibrationProfile | undefined;

  private get profile(): CalibrationProfile {
    this.profileCache ??= loadProfile(this.options.templateDir);
    return this.profileCache;
  }

  /**
   * Click through the harness ONLY after the point passes its surface check:
   * every surface automation touches is declared (strip bands, dropdown,
   * grids, search box), and a click outside its surface is refused BEFORE
   * sending — a strip click computed while the strip was off screen once
   * sprayed the top-left of the bare world, and a drifted cached row Y would
   * land in the game world. Refusals are guarded so misfires are measurable,
   * and callers treat a refusal like a failed click: diagnose, never retry
   * the same point blind.
   */
  private async surfaceClick(
    x: number,
    y: number,
    surface: keyof typeof CLICK_SURFACES,
    why: string,
  ): Promise<boolean> {
    const refusal = clickRefusal({ x, y }, CLICK_SURFACES[surface]);
    if (this.harness.guard("click-surface-refused", refusal !== undefined)) {
      this.log(`  ! refusing click "${why}" at (${x},${y}) — ${refusal}`);
      return false;
    }
    await this.harness.click(x, y, why);
    return true;
  }

  private async park(): Promise<void> {
    await this.host.send({ op: "move", ...PARK });
  }

  /**
   * The last moment a POSITIVE stash proof succeeded (title OCR, grid
   * lattice, or an observed panel repaint). Full-screen OCR proofs cost
   * 1.5-2s each and the trip cycle was paying several per hop for a panel
   * that verifiably repainted moments earlier — a fresh proof (<20s, no
   * anomaly since) stands in for a new one. Any recovery entry or
   * unobserved click resets the freshness to zero.
   */
  private lastStashProofAt = 0;

  /* ---------------- ensureSession ---------------- */

  async ensureSession(): Promise<void> {
    const endPhase = this.harness.startPhase("ensure-session");
    try {
      // A process killed mid-click leaves the virtual left button LATCHED —
      // the game then eats every click. A tiny drag in the dead zone clears it.
      await this.host.send({ op: "drag", x: PARK.x, y: PARK.y, x2: PARK.x + 2, y2: PARK.y + 2 });
      await this.harness.sleep(300, false);
      if (!(await this.navigation.ensureStash())) throw new Error("stash-not-openable");
      // The guild stash has NO Gear folder — every tab is top-level.
      if (!this.guildChest && !(await this.navigation.ensureFolderRowOpen())) {
        throw new Error("gear-folder-row-not-openable");
      }
      // The Highlight (search) box is never touched any more — the user
      // confirmed it is unused (2026-09-01), and ground-truth Ctrl+C
      // identification does not care about dimming. If a stale query ever
      // dims a tab, clear it by hand.
      endPhase();
    } catch (error) {
      endPhase(error instanceof SortStop ? "stopped" : "failed");
      throw error;
    }
  }

  /** Folder-list rows from the last verified read. Rows never move while the
   * stash stays open, so a cached read addresses every later hop without
   * OCR; any failed verification invalidates the cache. */
  private folderRowsCache: TabListRow[] | undefined;

  /** See TabNavigation.gotoTab. */
  async gotoTab(
    label: string,
    occurrence = 0,
    topLevel = false,
    rowY?: number,
    drain = false,
    shop = false,
  ): Promise<boolean> {
    return this.navigation.gotoTab(label, occurrence, topLevel, rowY, drain, shop);
  }

  /** Canonical top-strip labels seen readable this session. Together with
   * the one-time unmask hop this tells "unreadable because ACTIVE" apart
   * from "does not exist". */
  private readonly knownTopLabels = new Set<string>();

  /** See TabNavigation.listTopSources. */
  async listTopSources(): Promise<SourceTab[]> {
    return this.navigation.listTopSources();
  }

  /** See TabNavigation.listRemoveOnlySources. */
  async listRemoveOnlySources(): Promise<SourceTab[]> {
    return this.navigation.listRemoveOnlySources();
  }

  /** Where finds are attributed while a tab is being cleaned. */
  private findLocation = "bag";

  /** Triage tabs that failed navigation this session — detours to them stop. */
  private readonly unreachableTriageTabs = new Set<string>();

  private triageRouting(): SortTriageConfig | undefined {
    const triage = this.options.triage;
    if (!triage) return undefined;
    // Review/Dump are PERSONAL tabs — a guild session must never detour
    // items toward them (the deposit would land in a guild tab of that
    // name, or nowhere).
    if (this.guildChest) return undefined;
    return {
      evaluate: triage.evaluate,
      routing: triage.routing,
      minDetourConfidence: triage.minDetourConfidence ?? DEFAULT_MIN_DETOUR_CONFIDENCE,
    };
  }

  /** Route through the value tiers, cancelling detours to dead triage tabs. */
  private routeWithFallback(item: IdentifiedItem, config: SortTriageConfig | undefined): RoutedItem {
    const routed = routeIdentifiedItem(item, config);
    if (routed.detoured && this.unreachableTriageTabs.has(routed.dest)) {
      return { ...routed, dest: routed.fallbackDest, detoured: false };
    }
    return routed;
  }

  private recordFind(routed: RoutedItem): void {
    const record = findRecordFor(routed, this.findLocation, new Date().toISOString());
    if (!record) return;
    this.options.triage?.onFind?.(record);
    this.log(
      `  ★ find: ${record.name} (${record.itemClass}) → ${record.routedTo}` +
        (record.valueScore !== undefined
          ? ` [score ${record.valueScore}/100, confidence ${record.confidence}%]`
          : ` [${record.source}]`),
    );
  }

  /** Ledger throttle: one record per fingerprint per location per run. */
  private readonly observedKeys = new Set<string>();

  private readonly runId: string;

  /** Append every identified item to the inventory ledger (never throws). */
  private recordObservations(items: readonly IdentifiedItem[], location: string, partial = false): void {
    const sink = this.options.onObservation;
    if (!sink || items.length === 0) return;
    const records = inventoryRecordsFor(items, {
      location,
      runId: this.runId,
      at: new Date().toISOString(),
      ...(this.options.triage ? { evaluate: this.options.triage.evaluate } : {}),
      partial,
    });
    for (const record of records) {
      const key = `${this.runId}|${location}|${partial ? "p" : "f"}|${record.fingerprint}`;
      if (this.observedKeys.has(key)) continue;
      this.observedKeys.add(key);
      try {
        sink(record);
      } catch {
        // The ledger is a side journal; it must never fail a sort.
      }
    }
  }

  /**
   * File every identifiable bag item into its TRUE tab (junk to T tabs).
   * This is what cleans a "dirty" bag left by interruptions — no blanket
   * cascades into whatever tab is first.
   *
   * The bag is identified ONCE per load and remembered: after a deposit
   * lands, the deposited cells drop out of the model instead of the whole
   * bag being re-copyswept before every group (the old flow re-read a
   * shrinking bag between every filing). The bag-occupancy capture after
   * each deposit is the ground truth that reconciles the model — cells that
   * unexpectedly remain stay modelled, cells that appear get identified.
   */
  private async distributeBag(
    context: { returnTo?: SourceTab; deadDests?: Set<string>; navFailed?: Set<string> } = {},
  ): Promise<number> {
    const endPhase = this.harness.startPhase("distribute-bag");
    let filed = 0;
    /** cell key -> copy text, valid for this bag-load. */
    const bagReads = new Map<string, { cell: GridCell; text: string }>();
    const cellKey = (cell: GridCell) => `${cell.row},${cell.col}`;
    const stillInBag = async (points: readonly GridCell[]): Promise<GridCell[]> => {
      const occupied = new Set((await this.perception.currentBagCells()).map(cellKey));
      return points.filter((cell) => occupied.has(cellKey(cell)));
    };
    /** Last-resort placement for cells with no reachable home: junk tabs
     * first, then BACK to the tab they came from — the user's new layout has
     * no Weapons quad and no T tabs, so an axe in the Dump tab must return
     * to Dump rather than ride the bag forever and stall the run. Returns
     * how many cells remain stuck in the bag. */
    const bail = async (points: readonly GridCell[]): Promise<number> => {
      let remaining = await stillInBag(points);
      if (remaining.length === 0) return 0;
      await this.transfers.depositJunkCells(remaining);
      remaining = await stillInBag(remaining);
      // A drain source is NEVER a bail target: the game refuses deposits
      // into Remove-only tabs, so the return trip would silently fail and
      // spam refused clicks. The cells ride in the bag instead — deadDests
      // already stops further withdrawals of their class, and the run-end
      // report lists what is left.
      if (remaining.length > 0 && context.returnTo?.drain) {
        this.harness.guard("bail-skipped-drain-source", true);
        this.log(
          `  · ${remaining.length} cell(s) have no reachable home and the source is Remove-only — they ride in the bag`,
        );
        return remaining.length;
      }
      if (remaining.length > 0 && context.returnTo) {
        this.harness.guard("bag-bailed-to-source", true);
        await this.step(
          `${remaining.length} cell(s) have no reachable home — returning them to ${context.returnTo.label}`,
        );
        const back = context.returnTo;
        try {
          if (await this.navigation.gotoTab(back.label, back.occurrence, back.topLevel, back.rowY)) {
            await this.transfers.depositCells(remaining, back.label);
            remaining = await stillInBag(remaining);
          }
        } catch (error) {
          // A failed RETURN trip must not kill the whole run — the cells
          // simply ride in the bag to the next round / the final report.
          if (error instanceof SortStop) throw error;
          this.harness.guard("bail-return-failed", true);
          this.log(`  ! could not return ${remaining.length} cell(s) to ${back.label}: ${String(error instanceof Error ? error.message : error)}`);
        }
      }
      return remaining.length;
    };
    try {
      for (let round = 0; round < 12; round += 1) {
        const bag = this.transfers.depositTargets(await this.perception.currentBagCells());
        if (bag.length === 0) {
          endPhase();
          return filed;
        }
        // Reconcile the model with reality: forget cells that left the bag,
        // read only the cells the model does not know yet.
        const present = new Set(bag.map(cellKey));
        for (const key of [...bagReads.keys()]) {
          if (!present.has(key)) bagReads.delete(key);
        }
        const unknown = bag.filter((cell) => !bagReads.has(cellKey(cell)));
        if (unknown.length > 0) {
          await this.step(`identifying ${unknown.length}/${bag.length} bag cells`);
          const raw = await this.perception.captureRaw();
          const bagGridBox = this.profile.bagGrid
            ? toScreenBox(raw.client, this.profile.bagGrid)
            : undefined;
          const { reads } = await this.identification.identifyCells(unknown, {
            probePoint: bagGridBox
              ? (cell) => brightestCellPoint(raw.gray, raw.client, bagGridBox, 12, 5, cell)
              : undefined,
          });
          for (const read of reads) bagReads.set(cellKey(read.cell), read);
          this.recordObservations(groupIdentifiedCells(reads), "bag");
        }
        let items = groupIdentifiedCells([...bagReads.values()]);
        if (items.length === 0) {
          endPhase("bag-unreadable");
          return filed;
        }
        // Guild taxonomy remap, re-evaluated every round so a dest that
        // went full/dead mid-visit re-routes to its chain partner.
        if (this.guildChest) {
          const unavailable = new Set<string>([...this.fullDests, ...(context.deadDests ?? [])]);
          items = items.map((item) => ({ ...item, dest: guildDestForItem(item, unavailable) }));
        }
        // Value triage rides on the identification we already have: a
        // confident keep/sell detours to Review/Sell, a rule-dumped item to
        // Dump, everything else keeps its class destination.
        const config = this.triageRouting();
        const routed = items.map((item) => this.routeWithFallback(item, config));
        for (const entry of routed) {
          if (entry.detoured) this.recordFind(entry);
        }
        // Largest group first; the model carries the rest to later rounds
        // without re-reading them. Destinations already proven dead this
        // visit are bailed instead of re-probed every round.
        const groups = new Map<string, RoutedItem[]>();
        for (const entry of routed) {
          groups.set(entry.dest, [...(groups.get(entry.dest) ?? []), entry]);
        }
        const viable = [...groups.entries()]
          .filter(([groupDest]) => groupDest === "junk" || !context.deadDests?.has(groupDest))
          .sort((a, b) => b[1].length - a[1].length);
        if (viable.length === 0) {
          const stuck = await bail(routed.map((entry) => entry.item.cells[0]!));
          endPhase(stuck > 0 ? "dead-dests" : "bailed");
          return filed;
        }
        const [dest, group] = viable[0]!;
        const grabPoints = group.map((entry) => entry.item.cells[0]!);
        await this.step(`filing ${group.length} item(s) → ${dest}`);
        if (dest === "junk") {
          const left = await bail(grabPoints);
          filed += group.length - Math.min(group.length, left);
          if (left > 0) {
            endPhase("junk-stuck");
            return filed;
          }
          continue;
        }
        // Guild mode has no Gear folder: destination tabs are TOP-LEVEL
        // guild tabs of the same class names (whichever exist — missing
        // ones go dead and their items stay in the source, reported).
        if (!(await this.navigation.gotoTab(dest, 0, this.guildChest))) {
          const detours = group.filter((entry) => entry.detoured);
          if (detours.length === group.length) {
            // A dead triage tab must not loop the round forever: cancel
            // detours to it for the session; items re-route to class tabs.
            this.harness.guard("triage-tab-unreachable", true);
            this.unreachableTriageTabs.add(dest);
            this.log(`  ! triage tab "${dest}" unreachable — routing those items normally instead`);
            continue;
          }
          // Destination unreachable. Distinguish a NAVIGATION failure from
          // a genuinely missing tab (the layout has no Weapons quad since
          // the 2026-08-30 rework): a known gear tab that cannot be reached
          // right now gets ONE retry on a later trip before it is declared
          // dead — one flaky goto once dead-marked Helmets right after it
          // had accepted 12 deposits and stranded 7 items for the visit
          // (live 2026-09-01). Either way this group bails now.
          const knownTab = GEAR_TAB_NAMES.some((name) => labelsEqualFolded(name, dest));
          if (knownTab && context.navFailed && !context.navFailed.has(dest)) {
            context.navFailed.add(dest);
            this.harness.guard("dest-nav-failed-retry-later", true);
            this.log(`  ! "${dest}" navigation failed — items return to the source for one retry later`);
          } else {
            this.harness.guard("dest-unreachable-marked-dead", true);
            context.deadDests?.add(dest);
            this.log(`  ! "${dest}" unreachable — its items return to the source and stop being withdrawn`);
          }
          const left = await bail(grabPoints);
          filed += group.length - Math.min(group.length, left);
          continue;
        }
        const left = await this.transfers.depositCells(grabPoints, dest);
        filed += group.length - Math.min(group.length, left);
        // A clean deposit is a verified sighting at the destination (partial:
        // it adds to that tab's ledger contents without retiring anything).
        if (left === 0) this.recordObservations(group.map((entry) => entry.item), dest, true);
        if (left >= grabPoints.length) {
          if (group.every((entry) => entry.detoured)) {
            // A FULL triage tab must not push valuables into the junk flow:
            // stop detouring to it and let the items file to class tabs.
            this.harness.guard("triage-tab-full", true);
            this.unreachableTriageTabs.add(dest);
            await this.step(`${dest} is full — valuables route to their class tabs instead`);
            continue;
          }
          // The home tab refused the WHOLE group (full). A full home tab in
          // the same spot every round never trips the two-tab stuck rule —
          // overflow to junk tabs, else back to the source.
          this.harness.guard("home-tab-full-overflow", true);
          this.fullDests.add(dest);
          context.deadDests?.add(dest);
          await this.step(`${dest} is full — overflowing ${grabPoints.length} item(s)`);
          const junkLeft = await bail(grabPoints);
          filed += grabPoints.length - Math.min(grabPoints.length, junkLeft);
        }
      }
      endPhase("round-limit");
      return filed;
    } catch (error) {
      endPhase(error instanceof SortStop ? "stopped" : "failed");
      throw error;
    }
  }

  /** User-taught grid geometry per tab, persisted across sessions. */
  private gridCalibration: Record<string, { x: number; y: number; w: number; h: number; cols: number; rows: number }> = {};

  /* ---------------- shop seams (docs/HANDOFF-shop-listings.md) ---------------- */

  /**
   * Read-only tab visit for the shop flow: navigate (the shop flag rides the
   * source) and return the full phase-1 index without withdrawing anything.
   */
  async scanTab(
    source: SourceTab,
    options: {
      /** false = the caller already put the tab on screen (the Merchant
       * panel's own tab strip is not stash navigation); just index it. */
      navigate?: boolean;
    } = {},
  ): Promise<TabScanResult> {
    const key = source.occurrence ? `${source.label}#${source.occurrence}` : source.label;
    const endPhase = this.harness.startPhase(`scan:${key}`);
    this.findLocation = key;
    try {
      if (
        options.navigate !== false &&
        !(await this.navigation.gotoTab(
          source.label,
          source.occurrence,
          source.topLevel,
          source.rowY,
          source.drain,
          source.shop,
        ))
      ) {
        endPhase("source-unreachable");
        return { ok: false, reason: "source-unreachable" };
      }
      const index = await this.identification.indexTab(source, key);
      if (!index) {
        endPhase("no-geometry");
        return { ok: false, reason: "no-geometry" };
      }
      endPhase();
      return { ok: true, ...index };
    } catch (error) {
      endPhase(error instanceof SortStop ? "stopped" : "failed");
      throw error;
    } finally {
      this.findLocation = "bag";
    }
  }

  /** Current occupied bag cells (pixel occupancy), for the shop flow. */
  async bagCellsNow(): Promise<GridCell[]> {
    return this.perception.currentBagCells();
  }

  /** See StashPerception.occupiedStashCellsNow. */
  async occupiedStashCellsNow(
    geometry?: { region: { x: number; y: number; w: number; h: number }; cols: number; rows: number },
    topLevel = false,
  ): Promise<GridCell[]> {
    return this.perception.occupiedStashCellsNow(geometry, topLevel);
  }

  /** Identify every occupied bag cell by Ctrl+C — phase 2's item source. */
  async identifyBagItems(): Promise<{
    items: IdentifiedItem[];
    unread: GridCell[];
  }> {
    const cells = await this.perception.currentBagCells();
    const { items, unread } = await this.identification.identifyCells(cells, {});
    this.recordObservations(items, "bag");
    return { items, unread };
  }

  /** Hover + Ctrl+C one screen point — the shop flow's Note-line re-read. */
  async copyAt(x: number, y: number, hoverMs = 140): Promise<string> {
    return this.identification.copyItemAt(x, y, hoverMs);
  }

  /** See Transfers.withdrawItemsSerial. */
  async withdrawItemsSerial(
    items: readonly IdentifiedItem[],
    label: string,
  ): Promise<IdentifiedItem[]> {
    return this.transfers.withdrawItemsSerial(items, label);
  }

  /**
   * Deposit specific bag cells into the ACTIVE tab, bounce-verified. The
   * shop flow deposits with `shiftOnly` so stash affinities can never divert
   * an item away from the open (shop) tab. Returns how many cells stayed.
   */
  async depositBagCells(
    points: readonly GridCell[],
    destLabel: string,
    options: { shiftOnly?: boolean } = {},
  ): Promise<number> {
    return this.transfers.depositCells(points, destLabel, options);
  }

  async cleanTab(source: SourceTab): Promise<number> {
    const key = source.occurrence ? `${source.label}#${source.occurrence}` : source.label;
    // Triage tabs hold what the value tiers detoured — cleaning one would
    // scatter the finds back into class tabs.
    const routingCfg = this.options.triage?.routing;
    if (routingCfg && !source.topLevel && isTriageTabLabel(source.label, routingCfg)) {
      this.log(`  · ${key} is a triage tab — never cleaned`);
      return 0;
    }
    // The shop tab holds public listings — withdrawing them is delisting.
    // Only the shop flow's own verified actions may do that, never a clean.
    if (source.shop) {
      this.log(`  · ${key} is the designated shop tab — never cleaned (scanTab is the only read)`);
      return 0;
    }
    // A gear-folder tab owns its class; a top-level T tab "owns" junk — gear
    // items leave for the folder, junk stays where it lives.
    const own = source.topLevel
      ? undefined
      : GEAR_TAB_NAMES.find((name) => labelsSimilar(name, source.label));
    const endPhase = this.harness.startPhase(`clean:${key}`);
    let moved = 0;
    let lastForeign = Number.POSITIVE_INFINITY;
    let withdrawMisses = 0;
    /** Destinations proven unreachable/full during THIS visit — their items
     * stop being withdrawn (they would only churn bag→source forever). */
    const deadDests = new Set<string>();
    /** Known gear tabs whose navigation failed ONCE — retried on a later
     * trip before dead-marking (see distributeBag). */
    const navFailed = new Set<string>();
    this.findLocation = key;
    try {
      /* ---------------- PHASE 1: index the tab ONCE ----------------
       * The user's guarantee (2026-09-01): nothing else touches the stash
       * while a sort runs, so this single sweep IS the tab's state for the
       * whole visit — withdrawn items leave the model and nothing is ever
       * re-swept (the per-trip re-scans and the belt-and-braces
       * verification sweep went away with the assumption that required
       * them). Bailed items land back here in cells the model does not
       * track, but their destinations are dead/full, so they are never
       * withdrawn again this visit.
       */
      if (
        !(await this.navigation.gotoTab(
          source.label,
          source.occurrence,
          source.topLevel,
          source.rowY,
          source.drain,
        ))
      ) {
        endPhase("source-unreachable");
        return moved;
      }
      const index = await this.identification.indexTab(source, key);
      if (!index) {
        endPhase("no-geometry");
        return moved;
      }
      const { region, cols, rows, unread } = index;
      if (index.occupiedCount === 0) {
        if (source.drain) {
          this.log(`  · ${key}: zero occupied cells — fully drained (the tab will vanish on its own)`);
        }
        endPhase();
        return moved;
      }
      let modelItems = index.modelItems;
      /* ---------------- PHASE 2: withdraw trips from the index ----------------
       * Each trip packs the bag with the biggest DESTINATION groups that fit
       * (packTripByDest) so a bag-load deposits in one or two hops instead
       * of a dozen. The index is only ever reduced; the one read back from
       * the tab is the cheap pixel check for what a shortfall burst left.
       */
      for (let trip = 0; trip < 24; trip += 1) {
        const skippable = new Set<string>([
          ...deadDests,
          ...(source.topLevel ? this.fullDests : []),
        ]);
        // Guild taxonomy remap AFTER the unavailable set is known, so a
        // full "Armor 1" re-routes its items to "Armor 2" instead of
        // skipping them (and a fully unavailable chain resolves to "junk"
        // — the item stays put).
        const items = this.guildChest
          ? modelItems.map((item) => ({ ...item, dest: guildDestForItem(item, skippable) }))
          : modelItems;
        const foreign = foreignItemsFor(items, own, skippable.size > 0 ? skippable : undefined);
        const skipped = foreignItemsFor(items, own).length - foreign.length;
        if (skipped > 0) {
          this.log(
            `  · ${key}: leaving ${skipped} item(s) whose home tab is full or missing (${[...skippable].join(", ")})`,
          );
        }
        // Value triage: an item that gets to STAY by class may still be a
        // confident keep/sell — it leaves for the Review/Sell tab. Only
        // upward detours here; dump-tier items in a T tab already live where
        // junk lives, and churning them costs trips.
        const config = this.triageRouting();
        let leaving = foreign;
        if (config) {
          const alreadyLeaving = new Set(foreign);
          const detours = items
            .filter((item) => !alreadyLeaving.has(item))
            .map((item) => this.routeWithFallback(item, config))
            .filter(
              (entry) =>
                entry.detoured &&
                (entry.craft || entry.verdict?.tier === "keep" || entry.verdict?.tier === "sell"),
            );
          if (detours.length > 0) {
            this.log(`  · ${key}: ${detours.length} valuable item(s) detour to triage tabs`);
            leaving = [...foreign, ...detours.map((entry) => entry.item)];
          }
        }
        this.log(
          `  · ${key}: ${items.length} item(s) indexed, ${leaving.length} leaving ` +
            `(${[...new Set(leaving.map((f) => f.dest))].join(", ") || "none"})`,
        );
        if (leaving.length === 0) {
          if (source.drain) {
            // Everything routable has left; what stays is unreadable or
            // had a fully unavailable destination chain — report it.
            const staying = items.filter((item) => item.dest === "junk").length;
            this.log(
              `  · ${key}: drained — ${staying} item(s) left (unreadable or no open destination)` +
                (unread.length > 0 ? `, ${unread.length} unreadable cell(s)` : ""),
            );
          }
          endPhase();
          return moved;
        }
        if (leaving.length >= lastForeign) {
          await this.step(`${key}: ${leaving.length} item(s) refuse to move — stopping`);
          endPhase("stalled");
          return moved;
        }
        lastForeign = leaving.length;
        // Budget by PLACEMENT, not cell count: the packer simulates the
        // game's own first-fit fill of the 12x5 bag over its current
        // occupancy, so every withdraw click has a real landing spot.
        const bagCellsNow = await this.perception.currentBagCells();
        const batch = packTripByDest(leaving, bagCellsNow);
        const cellsNeeded = batch.reduce((sum, item) => sum + item.cells.length, 0);
        if (batch.length === 0) {
          await this.step("bag too full for any foreign item — filing bag first");
          await this.distributeBag({ returnTo: source, deadDests, navFailed });
          lastForeign = Number.POSITIVE_INFINITY;
          continue;
        }
        // Back to the source (the first trip is already there; later trips
        // return from wherever the last deposit landed).
        if (
          !(await this.navigation.gotoTab(
            source.label,
            source.occurrence,
            source.topLevel,
            source.rowY,
            source.drain,
          ))
        ) {
          endPhase("source-unreachable");
          return moved;
        }
        const grabPoints = batch.map((item) => item.cells[0]!);
        await this.step(
          `${key}: withdrawing ${batch.length} item(s) (${cellsNeeded} cells) → ${[...new Set(batch.map((item) => item.dest))].join(", ")}`,
        );
        let withdrawn: IdentifiedItem[];
        if (this.guildChest) {
          withdrawn = await this.transfers.guildWithdrawSerial(batch, leaving, key);
          if (withdrawn.length === 0) {
            endPhase("plan-not-executed");
            return moved;
          }
          await this.harness.sleep(400);
        } else {
          const bagBefore = bagCellsNow.length;
          // Park + one frame BEFORE the burst: if the burst under-delivers,
          // comparing this frame against a post-burst frame says exactly
          // which items stayed. The old occupancy-score check over-restored
          // 10 of 15 items live (2026-09-01) — the cursor rested on the last
          // clicked cell and its item TOOLTIP covered the grid, reading as
          // occupied cells everywhere.
          await this.park();
          const preBurst = await this.perception.captureRaw();
          const sent = await this.harness.burst(grabPoints, {
            found: leaving.flatMap((item) => item.cells),
            cellW: 56,
            cellH: 56,
            label: `clean ${key}: ${batch.length} items out`,
          });
          if (sent === 0) {
            endPhase("plan-not-executed");
            return moved;
          }
          // Unpaced settle POLL, not a fixed sleep: a paced 400ms (280ms at
          // pace 0.7) expired while the game was still processing the burst
          // chunks — the bag undercounted and the shortfall check
          // "restored" items that had actually left, every single trip
          // (watcher-bot finding #1, 2026-09-01). Two consecutive agreeing
          // reads are the commit signal.
          let bagAfter = await this.perception.bagCount();
          const settleDeadline = Date.now() + 2500 + batch.length * 50;
          for (;;) {
            await this.harness.sleep(300, false);
            const again = await this.perception.bagCount();
            const settled = again === bagAfter;
            bagAfter = again;
            if (settled || Date.now() >= settleDeadline) break;
          }
          // Postcondition: the bag must GROW by the batch's cells. Shrank
          // means the clicks landed on the WRONG side and deposited — the
          // world no longer matches the index; stop the visit loudly. Flat
          // means nothing came out (missed clicks / covered panel) — one
          // retry, then stop.
          const direction = withdrawObservation(bagBefore, bagAfter);
          if (direction === "shrank") {
            this.harness.guard("withdraw-wrong-direction", true);
            await this.step(`${key}: withdraw burst DEPOSITED (bag shrank) — stopping this visit`);
            endPhase("withdraw-anomaly");
            return moved;
          }
          if (direction === "flat") {
            this.harness.guard("withdraw-not-observed", true);
            withdrawMisses += 1;
            if (withdrawMisses >= 2) {
              await this.step(`${key}: two withdraw bursts landed nothing — stopping`);
              endPhase("stalled");
              return moved;
            }
            await this.step(`${key}: withdraw burst did not land — retrying`);
            lastForeign = Number.POSITIVE_INFINITY;
            continue;
          }
          withdrawMisses = 0;
          withdrawn = batch;
          const actualGrowth = bagAfter - bagBefore;
          if (actualGrowth < cellsNeeded) {
            // A partial burst: some clicks missed or were refused. Compare
            // the pre-burst frame against a fresh one, per item bounding
            // box: a withdrawn item's cells changed massively (sprite →
            // background), a stayed item's changed not at all. Park first
            // so no tooltip pollutes the after-frame. No re-sweep, no
            // hovering, immune to glare and occupancy-threshold guesses.
            await this.park();
            const cw = region.w / cols;
            const ch = region.h / rows;
            const stayedIn = (check: RawFrame): Set<IdentifiedItem> =>
              new Set(
                batch.filter((item) => {
                  const minR = Math.min(...item.cells.map((cell) => cell.row));
                  const maxR = Math.max(...item.cells.map((cell) => cell.row));
                  const minC = Math.min(...item.cells.map((cell) => cell.col));
                  const maxC = Math.max(...item.cells.map((cell) => cell.col));
                  const box = {
                    x: region.x + minC * cw,
                    y: region.y + minR * ch,
                    w: (maxC - minC + 1) * cw,
                    h: (maxR - minR + 1) * ch,
                  };
                  const fraction = regionChangedFraction(
                    preBurst.gray,
                    check.gray,
                    check.client,
                    box,
                    2,
                  );
                  return fraction < 0.15; // its pixels never moved — it stayed
                }),
              );
            let stayed = stayedIn(await this.perception.captureRaw());
            if (stayed.size > Math.ceil(batch.length * 0.3)) {
              // Implausibly many "stayed" — the removal animation may still
              // be painting. One later frame decides (the same trust-the-
              // later-read pattern the deposit bounce check uses).
              await this.harness.sleep(700, false);
              stayed = stayedIn(await this.perception.captureRaw());
            }
            if (stayed.size > 0) {
              this.harness.guard("withdraw-partial-restored", true);
              this.log(
                `  · ${key}: ${stayed.size} item(s) did not leave — kept in the index for the next trip`,
              );
              withdrawn = batch.filter((item) => !stayed.has(item));
            }
          }
        }
        moved += withdrawn.length;
        // The withdrawn items are the ONLY change to the tab — drop exactly
        // them from the index, matched by grab cell (guild remaps clone the
        // items, so identity alone cannot be trusted).
        const withdrawnKeys = new Set(
          withdrawn.map((item) => `${item.cells[0]!.row},${item.cells[0]!.col}`),
        );
        modelItems = modelItems.filter(
          (item) => !withdrawnKeys.has(`${item.cells[0]!.row},${item.cells[0]!.col}`),
        );
        await this.distributeBag({ returnTo: source, deadDests, navFailed });
      }
      endPhase("trip-limit");
      return moved;
    } catch (error) {
      endPhase(error instanceof SortStop ? "stopped" : "failed");
      throw error;
    } finally {
      this.findLocation = "bag";
    }
  }

  /* ---------------- run ---------------- */

  /**
   * Enumerate the folder's tabs from the live folder list, in row order.
   * Duplicate labels (two "Rings" rows) become distinct sources via their
   * occurrence index; Remove-only rows are excluded outright.
   */
  async listSources(): Promise<SourceTab[]> {
    const rows = await this.navigation.openFolderList();
    this.folderRowsCache = rows; // rows never move — later hops skip the OCR
    const seen = new Map<string, number>();
    const sources: SourceTab[] = [];
    for (const row of rows) {
      if (!row.readable) continue;
      const label = row.label.trim();
      if (!label || isRemoveOnlyTabLabel(label)) continue;
      // A row whose label collapses to a single character is OCR debris (the
      // Sceptre row once read as "O") — the synthesis pass below re-queues
      // the real tab it garbled from by its known name.
      if (normalizeTabLabel(label).length < 2) continue;
      // Top-level rows can bleed into a folder read on a list-transition
      // frame (Gear, AFFINITIES and T10 were once queued as folder tabs).
      // The folder only ever holds gear tabs — drop such labels outright.
      const lower = label.toLowerCase();
      if (lower === "gear" || lower === "affinities" || canonicalTTabLabel(label)) continue;
      const occurrence = seen.get(label) ?? 0;
      seen.set(label, occurrence + 1);
      sources.push({ label, occurrence });
    }
    // The ACTIVE tab's highlight can defeat its own row's OCR (Jewels'
    // magenta, Amulets'), silently dropping a different tab from every run.
    // Synthesize the known gear tabs that are missing; the goto probe +
    // requeue in run() sort out whether they really exist.
    for (const name of GEAR_TAB_NAMES) {
      // A row that exactly names a DIFFERENT tab cannot claim this one —
      // the Staff row loose-matches "QuarterStaff" by containment and once
      // silently dropped QuarterStaff from the whole run.
      const claimed = sources.some(
        (source) =>
          labelsSimilar(source.label, name) &&
          !GEAR_TAB_NAMES.some(
            (other) => !labelsEqualFolded(other, name) && labelsEqualFolded(source.label, other),
          ),
      );
      if (!claimed) {
        this.log(`  · "${name}" not visible in the list (active-tab highlight?) — queueing it anyway`);
        sources.push({ label: name, occurrence: 0 });
      }
    }
    return sources;
  }

  /**
   * Sort everything in scope by ground truth: the Gear folder's tabs (each
   * ends holding only its class) and/or the top-level T* tabs (gear items
   * leave for the folder, junk stays). `sourceFilter` (from --sources=)
   * restricts which tabs to process.
   */
  async run(
    sourceFilter?: readonly string[],
    scope: "gear" | "tabs" | "all" = "all",
  ): Promise<number> {
    const drainMode = this.options.drainRemoveOnly === true;
    if (this.guildChest && !drainMode) {
      // The only guild flow so far is the Remove-only drain; a plain sort
      // would enumerate personal-stash structures that do not exist here.
      throw new Error("guild-chest-requires-drain-remove-only");
    }
    await this.ensureSession();
    if (this.guildChest && !this.options.dryRun) {
      // A guild live run files the whole bag into GUILD tabs — anything the
      // character was already carrying would be donated to the guild by
      // accident. Demand an empty bag instead of guessing what is loot.
      const carried = await this.perception.bagCount();
      if (carried > 0) {
        throw new Error(
          `guild-live-requires-empty-bag — ${carried} occupied bag cell(s); empty the inventory and rerun`,
        );
      }
      this.log(
        `guild pacing: serial actions, ≥${GUILD_PACE.itemMs}ms/item, ≥${GUILD_PACE.tabMs}ms/tab-switch, ` +
          "commit-verified each action; every action is visible in the guild log",
      );
    }
    const discovered: SourceTab[] = [];
    if (drainMode) {
      // The drain flow's sources are the Remove-only tabs and NOTHING else —
      // normal discovery stays out so a drain run cannot wander into sorting.
      discovered.push(...(await this.navigation.listRemoveOnlySources()));
    } else {
      if (scope !== "tabs") discovered.push(...(await this.listSources()));
      if (scope !== "gear") discovered.push(...(await this.navigation.listTopSources()));
    }
    // Drain filters match EXACTLY: Remove-only labels OCR reliably, and the
    // guild's numeric labels containment-match each other under the loose
    // rule ("1 (Remove-only)" sits inside "31 (Remove-only)") — a one-tab
    // live test must stay one tab.
    const filterMatches = (wanted: string, label: string): boolean =>
      drainMode
        ? wanted === label || labelsEqualFolded(wanted, label)
        : wanted === label || labelsSimilar(wanted, label);
    const sources = sourceFilter?.length
      ? discovered.filter((source) => sourceFilter.some((wanted) => filterMatches(wanted, source.label)))
      : discovered;
    // A tab the user NAMED must be tried even when discovery missed it — the
    // ACTIVE tab's label routinely fails to OCR (highlight), and it is very
    // often the active one the user wants sorted. The goto probe decides
    // whether it really exists.
    for (const wanted of sourceFilter ?? []) {
      if (sources.some((source) => filterMatches(wanted, source.label))) {
        continue;
      }
      if (drainMode) {
        // A drain probe must NAME a Remove-only label — probing "Armour"
        // could select and drain a regular tab of that name. (Sorting a
        // wrong tab is harmless; the refusal is about keeping drain runs
        // exact.) The full label with its (Remove-only) suffix is required.
        if (!isDrainableRemoveOnlyLabel(wanted)) {
          this.log(
            `  ! drain source "${wanted}" is not a Remove-only label — skipped (use the full label, e.g. "${wanted} (Remove-only)")`,
          );
          continue;
        }
        this.log(`  · requested drain source "${wanted}" not in discovery — probing it directly`);
        sources.push({ label: wanted, occurrence: 0, topLevel: true, drain: true });
        continue;
      }
      const isGearTab = GEAR_TAB_NAMES.some((name) => labelsEqualFolded(name, wanted));
      this.log(`  · requested source "${wanted}" not in discovery — probing it directly`);
      sources.push({ label: wanted, occurrence: 0, ...(isGearTab ? {} : { topLevel: true as const }) });
    }
    if (drainMode && sources.length === 0) {
      this.log("no Remove-only tabs found — nothing to drain");
      return 0;
    }
    this.log(
      `${drainMode ? "DRAINING (withdraw-only)" : "sorting"} ${sources.length} tab(s): ${sources
        .map((s) => (s.occurrence ? `${s.label}#${s.occurrence}` : s.label) + (s.topLevel ? "^" : ""))
        .join(", ")} (^ = top-level)`,
    );
    // Bail target for homeless items: the first top-level source (the Dump
    // tab in the default flow). Items whose home tab is full or missing get
    // verifiably returned there instead of riding the bag forever — a drain
    // source never qualifies (deposits into Remove-only tabs are refused).
    const defaultReturn = sources.find((source) => source.topLevel && !source.drain);
    // A dirty bag from earlier interruptions gets filed FIRST, each item to
    // its true tab by Ctrl+C identity — never dumped wholesale somewhere.
    // Guild runs skip this: live requires an empty bag (gate above), and a
    // dry-run must not churn plans for personal items against guild tabs.
    let moved = this.guildChest
      ? 0
      : await this.distributeBag(defaultReturn ? { returnTo: defaultReturn } : {});
    const queue = [...sources];
    const requeued = new Set<string>();
    const unreachable: string[] = [];
    while (queue.length > 0) {
      const source = queue.shift()!;
      const key =
        (source.occurrence ? `${source.label}#${source.occurrence}` : source.label) +
        (source.topLevel ? "^" : "");
      // Probe the source once. An unreachable tab is usually the CURRENTLY
      // ACTIVE one whose highlight defeats OCR (Jewels' magenta) — by the
      // time it comes around again another tab is active and it reads fine.
      // (A fully drained Remove-only tab also VANISHES from the account —
      // for drain sources, unreachable-and-skipped is a normal outcome.)
      if (
        !(await this.navigation.gotoTab(source.label, source.occurrence, source.topLevel, source.rowY, source.drain))
      ) {
        if (!requeued.has(key)) {
          requeued.add(key);
          queue.push(source);
          this.log(`  · ${key} unreachable right now — retrying after the other tabs`);
        } else {
          this.log(`! source ${key} unreachable — skipped`);
          unreachable.push(key);
        }
        continue;
      }
      moved += await this.cleanTab(source);
      this.log(`${key}: done`);
    }
    // The run may not end while depositable identified items remain in the
    // bag — file them (bailing the homeless to the default source) and
    // REPORT whatever survives, cell by cell. Guild runs demanded an empty
    // bag up front and file everything inline.
    if (!this.guildChest) moved += await this.transfers.finishBag(defaultReturn);
    if (unreachable.length > 0) {
      this.log(`! unreachable tabs this session (labels never OCRed): ${unreachable.join(", ")}`);
    }
    if (this.fullDests.size > 0) {
      this.log(
        `! full destination tab(s): ${[...this.fullDests].join(", ")} — their overflow lives in T tabs until space frees up`,
      );
    }
    if (this.undepositableBag.size > 0) {
      this.log(
        `! ${this.undepositableBag.size} bag cell(s) would not deposit anywhere ` +
          `(shift+ctrl included) — left in the bag for you to place by hand`,
      );
    }
    return moved;
  }
}
