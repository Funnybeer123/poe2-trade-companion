/**
 * Gear sorter — tab navigation: stash open/recovery, the folder and
 * top-level side lists, strip-header selection and the tab-switch proofs.
 * Split out of gearSorter.ts mechanically; the orchestrator (GearSorter)
 * owns the shared state and hands it over through SorterContext.
 */
import {
  STRIP_ROWS,
  TAB_LIST,
  findLabelSegment,
  pickExact,
  pickUnique,
  type StripEntry,
  type TabListRow,
} from "../stashTabKit.js";
import { SortStop } from "../sortHarness.js";
import { labelsEqualFolded, labelsSimilar, normalizeTabLabel } from "../../core/tabList.js";
import { isDrainableRemoveOnlyLabel, isRemoveOnlyTabLabel } from "../../core/stashTabAdmin.js";
import { brightHeaderRuns, regionChangedFraction } from "../../core/itemSprites.js";
import {
  GEAR_TAB_NAMES,
  canonicalTTabLabel,
  classifyListRead,
  decideListToggle,
  isTTabLabel,
  type ListVisibility,
} from "../../core/gearSort.js";
import {
  STASH_BAND,
  INVENTORY_BAND,
  LIST_TOGGLE_TOP,
  LIST_TOGGLE_FOLDER,
  LIST_ROW_CLICK_X,
  LIST_PIXEL_PROBE,
  GUILD_PACE,
} from "./context.js";
import type { OcrText, RawFrame, SourceTab, SorterContext } from "./context.js";

export class TabNavigation {
  constructor(private readonly ctx: SorterContext) {}

  /**
   * label -> ABSOLUTE list-row click Y, remembered from successful finds.
   * Some labels (the red Weapons tab) OCR as unreadable more often than not —
   * a cached position lets navigation keep working through an unreadable
   * frame. It must be the screen Y, never a slot INDEX: slot numbering
   * re-anchors to the first line OCR happens to see, so one missed top row
   * shifted every cached slot one row down and deposited 56 rings into
   * Helmets (watched live). Row positions themselves never move.
   */
  private readonly rowYCache = new Map<string, number>();

  /** Positive "the stash panel is open" proof: the cheap lattice check
   * first (one capture, no OCR), the panel-title OCR as fallback — a
   * jam-packed quad defeats the lattice detector (watched live on the
   * user's Dump tab). */
  private async stashOpenProof(): Promise<boolean> {
    return (await this.ctx.perception.stashGridVisible()) || (await this.ctx.perception.stashTitleVisible());
  }

  /**
   * Change-detection probe for "the tab actually switched": the strip rows
   * PLUS the top of the grid. Near-empty destination tabs are pixel-identical
   * in a grid-only band (tab-switch-not-observed fired 44× last session on
   * hops that had actually succeeded, burning the 1100ms cap each time), but
   * the header highlight always moves on a real switch — so the probe covers
   * both "the grid repainted" and "the highlight moved" (dump-sort handoff
   * item 5).
   */
  private tabSwitchProbe(): { x: number; y: number; w: number; h: number } | undefined {
    const bounds = this.ctx.perception.calibratedStashBounds();
    if (!bounds) return undefined;
    const top = STRIP_ROWS.top.min + 4;
    return { x: bounds.x, y: top, w: bounds.w, h: Math.round(bounds.y - top + 120) };
  }

  /**
   * Wait for the newly clicked tab to render: change-then-stable on the grid
   * strip when calibration gives us a probe region, else the legacy fixed
   * sleep + perception settle. Returns what the probe SAW — "changed" is the
   * positive proof a repaint happened; "unknown" means the legacy settle ran
   * (no probe region, or a host without the pixwait op).
   */
  private async settleAfterTabClick(
    expectChange: boolean,
  ): Promise<"changed" | "unchanged" | "unknown"> {
    const strip = this.tabSwitchProbe();
    if (strip) {
      const changed = await this.ctx.perception.pixwait(strip, {
        waitChangeMs: expectChange ? 1100 : 0,
        stableMs: 140,
      });
      if (changed !== undefined) {
        if (expectChange && !changed) {
          // No repaint seen — could be the same tab, a slow frame, or a
          // missed click. One legacy-style settle keeps this honest.
          this.ctx.harness.guard("tab-switch-not-observed", true);
          await this.ctx.harness.sleep(500, false);
          return "unchanged";
        }
        return changed ? "changed" : "unknown";
      }
    }
    await this.ctx.harness.sleep(1000);
    await this.ctx.perception.settleGrid();
    return "unknown";
  }

  /**
   * Race-free tab-switch observation, BASELINE-FIRST: pixwait grabs its
   * change baseline AFTER the click that causes the change, so its
   * change-wait missed 20 of 20 real switches live (2026-09-01) and every
   * hop burned the 1100ms cap + 500ms penalty before the pre-click
   * comparison rescued it. The comparison IS the observation now — over the
   * strip plus the WHOLE grid (a real switch moves tens of thousands of
   * pixels; a static panel ~none; live measurements: no-op 0.00%, real
   * switches 11-27%) — and pixwait only holds for repaint stability once a
   * change is seen, so the grid proof never reads a mid-repaint frame.
   */
  private async observeTabSwitch(
    before: RawFrame | undefined,
    expectChange: boolean,
  ): Promise<"changed" | "unchanged" | "unknown"> {
    if (!before || !expectChange) return this.settleAfterTabClick(expectChange);
    const bounds = this.ctx.perception.calibratedStashBounds();
    if (!bounds) return this.settleAfterTabClick(expectChange);
    const top = STRIP_ROWS.top.min + 4;
    const probe = { x: bounds.x, y: top, w: bounds.w, h: bounds.y + bounds.h - top };
    if (await this.ctx.perception.regionChangedSince(before, probe, 1200)) {
      await this.ctx.perception.pixwait(probe, { stableMs: 140 });
      // A live, repainting stash panel is also positive proof the stash UI
      // is on screen — nothing else repaints that region.
      this.ctx.perception.noteStashProof();
      return "changed";
    }
    this.ctx.harness.guard("tab-switch-not-observed", true);
    this.ctx.log("  · switch check: no panel change against the pre-click frame");
    return "unchanged";
  }

  /** Get the stash panel + inventory open, with bounded, diagnosed recovery. */
  async ensureStash(): Promise<boolean> {
    // Recovery can close the dropdown underneath us (Escape, panel re-open,
    // chest re-click) — the folder-list flag is OBSERVATION-only, and entering
    // recovery ends the observation (dump-sort handoff item 3). The same for
    // the stash-proof freshness: recovery means doubt.
    this.folderListOpen = false;
    this.ctx.lastStashProofAt = 0;
    let chestClicks = 0;
    let invToggles = 0;
    let navClicks = 0;
    const maxChestClicks = this.ctx.options.maxChestClicks ?? 2;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await this.ctx.park();
      await this.ctx.harness.sleep(350, false);
      const stashOpen = this.ctx.titleMatchesChest(await this.ctx.perception.ocrBand(STASH_BAND));
      let invOpen = /inventor/i.test(await this.ctx.perception.ocrBand(INVENTORY_BAND));
      if (stashOpen && !invOpen) {
        // Second opinion before touching anything — a tooltip can cover the title.
        await this.ctx.harness.sleep(600, false);
        invOpen = /inventor/i.test(await this.ctx.perception.ocrBand(INVENTORY_BAND));
      }
      if (stashOpen && invOpen) return true;
      if (stashOpen && !invOpen) {
        // Never fight a toggle: at most one corrective `i` press.
        if (this.ctx.harness.guard("inventory-toggle", invToggles >= 1)) return false;
        invToggles += 1;
        await this.ctx.host.send({ op: "focus" });
        await this.ctx.harness.sleep(250);
        await this.ctx.host.send({ op: "hotkey", keys: "i" });
        await this.ctx.harness.sleep(700);
        continue;
      }
      // Diagnose from one full OCR pass — a blind Escape here once OPENED the
      // pause menu on top of a perfectly good stash and sabotaged the retries.
      const reply = await this.ctx.host.send({ op: "ocr" });
      const lines = (Array.isArray(reply.lines) ? reply.lines : []) as OcrText[];
      const find = (re: RegExp) => lines.find((line) => re.test(line.text.trim()));
      const resume = find(/^resume/i);
      if (this.ctx.harness.guard("pause-menu-open", !!resume)) {
        await this.ctx.host.send({ op: "focus" });
        await this.ctx.harness.sleep(200);
        await this.ctx.harness.click(
          Math.round(resume!.x + resume!.w / 2),
          Math.round(resume!.y + resume!.h / 2),
          "close pause menu (Resume)",
        );
        await this.ctx.harness.sleep(800);
        continue;
      }
      const optionsOpen =
        !!find(/DISPLAY SETTINGS|SUPPORT GEM CAPACITY|PASSIVE SKILL|CHARACTER SHEET|ATLAS/i) ||
        (!!find(/^OPTIONS$/i) && !!find(/GRAPHICS|RENDERER/i));
      if (this.ctx.harness.guard("options-panel-open", optionsOpen)) {
        await this.ctx.host.send({ op: "focus" });
        await this.ctx.harness.sleep(200);
        await this.ctx.host.send({ op: "hotkey", keys: "escape" });
        await this.ctx.harness.sleep(800);
        continue;
      }
      // Find the wanted chest's nameplate at click time, full-screen OCR
      // only: mid-size region crops intermittently return zero lines. The
      // rule inverts per chest mode: personal wants the bare "Stash" plate
      // and excludes anything near a "Guild" line (±300px); guild wants the
      // plate that READS guild ("Guild Stash", or a split "Guild" line).
      // Both exclude the minimap/quest area (x>3000) — the minimap prints
      // the same names and clicking it walks the character into a corner.
      const inWorld = (line: OcrText) =>
        line.y >= 150 && line.y <= 1800 && line.x >= 500 && line.x <= 3000;
      const guilds = lines.filter((line) => /guild/i.test(line.text));
      const plate = this.ctx.guildChest
        ? lines.find((line) => /guild/i.test(line.text) && inWorld(line))
        : lines.find(
            (line) =>
              /^stash$/i.test(line.text.trim()) &&
              inWorld(line) &&
              !guilds.some((g) => Math.abs(g.x - line.x) < 300 && Math.abs(g.y - line.y) < 60),
          );
      // DESTRUCTIVE-CLICK GATE: a "not enough space" toast (bounced deposit)
      // can cover the stash TITLE for a few seconds, faking "panel closed"
      // while the panel is fully open — and the world's Stash nameplate is
      // visible BESIDE the open panel, so the chest-click below would land
      // in the world, walk the character, and close the panel for real
      // (killed two live runs, 2026-08-30). Before any walk/chest click,
      // require the PIXELS to agree that no stash grid is on screen.
      if (await this.ctx.perception.stashGridVisible()) {
        this.ctx.harness.guard("stash-open-by-grid-despite-title-miss", true);
        await this.ctx.harness.sleep(1200, false); // let the toast fade
        continue;
      }
      if (!plate) {
        // Chest not on screen — the minimap's label is safe as a
        // NAVIGATION click: it walks the character toward the chest.
        const miniStash = this.ctx.guildChest
          ? lines.find((line) => /guild/i.test(line.text) && line.x > 3250 && line.y < 600)
          : lines.find(
              (line) => /^stash$/i.test(line.text.trim()) && line.x > 3250 && line.y < 600,
            );
        if (this.ctx.harness.guard("minimap-navigation", !!miniStash && navClicks < 2)) {
          navClicks += 1;
          await this.ctx.host.send({ op: "focus" });
          await this.ctx.harness.sleep(250);
          await this.ctx.harness.click(
            Math.round(miniStash!.x + miniStash!.w / 2),
            Math.round(miniStash!.y + miniStash!.h / 2),
            "walk toward stash (minimap)",
          );
          await this.ctx.harness.sleep(6000, false); // let the character walk
          continue;
        }
      }
      if (plate) {
        // Two attempts with generous pathing time, then give up loudly —
        // wandering click-spam reads as "randomly clicking around my hideout".
        if (this.ctx.harness.guard("chest-clicks-exhausted", chestClicks >= maxChestClicks)) return false;
        chestClicks += 1;
        await this.ctx.host.send({ op: "focus" });
        await this.ctx.harness.sleep(250);
        await this.ctx.harness.click(
          Math.round(plate.x + plate.w / 2),
          Math.round(plate.y + plate.h / 2 + 70),
          "open stash chest",
        );
        await this.ctx.harness.sleep(5000, false);
        continue;
      }
      // Nothing recognisable — transient frame. Wait it out, never guess-click.
      await this.ctx.harness.sleep(1500, false);
    }
    this.ctx.perception.saveDebugFrame(await this.ctx.perception.captureFrame(), "stash-unrecoverable");
    return false;
  }

  /* ---------------- tab-list-only navigation ---------------- */

  private gearRowsIn(rows: readonly TabListRow[]): TabListRow[] {
    return rows.filter((row) =>
      GEAR_TAB_NAMES.some((name) => row.label.trim() === name || labelsSimilar(row.label, name)),
    );
  }

  /**
   * The dropdown lists the ACTIVE tab's container. Detect which one by
   * POSITIVE markers on both sides: gear tab names mean the folder,
   * "Gear"/"AFFINITIES" rows mean the top level. A read matching neither is a
   * bad OCR frame ("ambiguous") and must be retried, never acted on — judging
   * top-level by the mere absence of gear names once flapped the dropdown
   * closed/open forever on garbled reads.
   */
  private listContext(rows: readonly TabListRow[]): "folder" | "top-level" | "ambiguous" {
    // The guild stash has no folders at all — any stable list read IS the
    // top-level list; demanding the personal-stash markers ("Gear",
    // "AFFINITIES") would flap the dropdown forever.
    if (this.ctx.guildChest) return "top-level";
    // The dropdown is ONE scrollable list: top-level rows sit above the
    // folder's children, and a scrolled state shows both at once (stable
    // across reads — not a transition glitch; watched live). A frame with
    // gear rows is therefore usable as a folder read; the caller strips the
    // top-level rows so matching can never click them.
    if (this.gearRowsIn(rows).length >= 2) return "folder";
    if (rows.some((row) => /^(gear|affinities)$/i.test(row.label.trim()))) return "top-level";
    return "ambiguous";
  }

  /** True for rows that belong to the top-level part of the combined list —
   * the Gear folder row itself, AFFINITIES, T tabs, and Remove-only tabs. */
  private isTopLevelRowLabel(label: string): boolean {
    const trimmed = label.trim();
    return (
      /^(gear|affinities)$/i.test(trimmed) ||
      Boolean(canonicalTTabLabel(trimmed)) ||
      isRemoveOnlyTabLabel(trimmed)
    );
  }

  private describeRows(rows: readonly TabListRow[]): string {
    return rows.map((row) => (row.readable ? row.label : "·")).join(" | ");
  }

  /**
   * Make sure the strip's second row (the open Gear folder's tabs) exists —
   * the folder list chevron only renders alongside it. This is the only
   * strip interaction in the sorter, and it clicks the FOLDER HEADER on the
   * top row, never a tab.
   */
  async ensureFolderRowOpen(): Promise<boolean> {
    // With a SPECIAL tab active (Currency, Flask, Maps …) the strip's second
    // row — and its chevron — belongs to THAT group, and the chevron then
    // opens the special list forever (livelocked a run). Only positive
    // evidence of the special group rejects the row; garbled gear labels
    // must not trigger a pointless (and collapsing) header re-click.
    const specialGroup = (entries: ReadonlyArray<{ label: string }>): boolean =>
      entries.some(
        (entry) =>
          /flask|abyss|breach|relic|map|fragment|ritual|rune|expedition|gem|delir|essenc|dist|price|\bcur\b/i.test(
            entry.label,
          ) || isRemoveOnlyTabLabel(entry.label),
      );
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const strip = await this.ctx.kit.readStrip();
      const wrongGroup = specialGroup(strip.folder);
      if (strip.folder.length > 0 && !wrongGroup) return true;
      if (this.ctx.harness.guard("strip-wrong-group", wrongGroup)) {
        this.ctx.log(
          `  · strip second row shows the SPECIAL group [${strip.folder.map((e) => e.label).join(" | ")}] — re-selecting Gear`,
        );
      }
      let header = strip.top.find((entry) => /gear/i.test(entry.label));
      if (!header) {
        // Never page the scroll arrows blind: with the stash panel gone the
        // arrow coordinate points at the bare world — this was the "clicking
        // top-left of my screen" incident. A positive stash proof gates
        // every arrow click, and a strip that VANISHES mid-page stops the
        // paging instead of spraying the remaining clicks.
        if (!(await this.stashOpenProof())) {
          this.ctx.harness.guard("strip-clicks-refused-no-stash", true);
          if (!(await this.ensureStash())) return false;
          continue;
        }
        // Selecting any tab scrolls the strip; a junk trip to a T tab can
        // leave it far right with "Gear" off-screen (seen live: top row read
        // only "T13"). Page the top row back toward its left end, where the
        // Gear header lives, checking as we go.
        this.ctx.harness.guard("strip-scrolled-off-gear", true);
        for (let page = 0; page < 4 && !header; page += 1) {
          for (let step = 0; step < 4; step += 1) {
            if (
              !(await this.ctx.surfaceClick(
                52,
                212,
                "stripTop",
                `scroll tab strip left (${page * 4 + step + 1}/16)`,
              ))
            ) {
              return false;
            }
            await this.ctx.harness.sleep(260, false);
          }
          await this.ctx.park();
          const reread = await this.ctx.kit.readStrip();
          if (reread.top.length === 0 && reread.folder.length === 0) {
            this.ctx.harness.guard("strip-vanished-mid-scroll", true);
            break; // stash likely gone — let the recovery below diagnose
          }
          header = reread.top.find((entry) => /gear/i.test(entry.label));
        }
      }
      if (!header) {
        if (!(await this.ensureStash())) return false;
        continue;
      }
      // A merged OCR line centres on the crack between headers; bias left.
      const merged = !/^gear$/i.test(header.label.trim());
      const clickX = merged ? Math.round(header.point.x - header.width / 2 + 35) : header.point.x;
      await this.ctx.host.send({ op: "focus" });
      await this.ctx.harness.sleep(200);
      if (!(await this.ctx.surfaceClick(clickX, header.point.y, "stripTop", "open Gear folder row"))) {
        continue;
      }
      await this.ctx.harness.sleep(900);
    }
    const strip = await this.ctx.kit.readStrip();
    return strip.folder.length > 0 && !specialGroup(strip.folder);
  }

  /**
   * Get the FOLDER list open and read its rows, with the one-click-verified
   * toggle discipline (dump-sort handoff item 3): visibility is DETECTED
   * from every read (≥4 rows + folder context = open; zero rows = closed),
   * the chevron is clicked ONLY when the observed state must change, and
   * every click's effect is verified by the next read — an unchanged state
   * gets ONE retry, then falls to recovery. Blind alternating toggles (the
   * old close-then-immediately-reopen in one iteration) are gone.
   *
   * In this layout the folder chevron is the ONLY dropdown toggle that
   * renders — the old top-toggle click at (1287,212) landed on a control
   * that does not exist here (it is inside the top strip band and could
   * even select a tab), so no personal-chest path clicks it any more.
   */
  async openFolderList(): Promise<TabListRow[]> {
    // A fresh positive stash proof (an observed repaint seconds ago) stands
    // in for the 1.5-2s title-OCR round — the trip cycle paid several of
    // these per hop for a panel that verifiably just repainted.
    if (!this.ctx.perception.stashRecentlyProven() && !(await this.ctx.perception.stashTitleVisible())) {
      throw new Error("stash-panel-closed");
    }
    this.folderListOpen = false; // unknown until a read verifies it
    // A hover tooltip from wherever the cursor last rested can overlap the
    // list region and OCR as phantom tab rows (jewel names once queued as
    // eight tabs) — park before every read so no tooltip is showing.
    await this.ctx.park();
    /** Visibility right before the last toggle click, pending verification. */
    let pendingFrom: ListVisibility | undefined;
    let unverifiedToggles = 0;
    let unreadableReads = 0;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const rows = await this.ctx.kit.readTabList();
      let visibility = classifyListRead(rows.length, this.listContext(rows));
      if (visibility === "unreadable") {
        // A half-drawn transition frame: re-read once before believing it; a
        // second unreadable read in a row means the list is closed with a
        // stray world line or two leaking through the filters.
        unreadableReads += 1;
        if (unreadableReads < 2) {
          await this.ctx.harness.sleep(400, false);
          continue;
        }
        visibility = "closed";
      }
      unreadableReads = 0;
      // Verify the previous toggle actually changed the state before doing
      // anything else. Unchanged = ONE retry (the decision below re-clicks),
      // then recovery — never a blind toggle fight.
      if (pendingFrom !== undefined && visibility === pendingFrom) {
        this.ctx.harness.guard("list-toggle-unverified", true);
        unverifiedToggles += 1;
        if (unverifiedToggles >= 2) {
          if (!(await this.ensureStash())) throw new Error("stash-lost-and-unrecoverable");
          unverifiedToggles = 0;
          pendingFrom = undefined;
          continue;
        }
      } else {
        unverifiedToggles = 0;
      }
      pendingFrom = undefined;
      const action = decideListToggle(visibility, "folder");
      if (action === "none") {
        this.folderListOpen = true;
        // Remember what the OPEN list looks like — the trip cycle's fast
        // reopen re-proves "list showing" against this frame with zero OCR.
        this.folderListOpenRef = await this.ctx.perception.captureRaw();
        // Strip the top-level rows of the combined list before returning: a
        // scrolled window shows them above the children, and matching must
        // never click Gear/AFFINITIES/T-tab rows while hunting a folder tab.
        return rows.filter((row) => !(row.readable && this.isTopLevelRowLabel(row.label)));
      }
      if (visibility === "top-level" || visibility === "ambiguous-open") {
        // A stable scrolled window (top-level rows on top, or parked in the
        // special-tabs region with no gear rows at all — re-reading forever
        // livelocked a run): ONE chevron click closes the list and resets
        // its scroll; the next read verifies it actually closed.
        this.ctx.harness.guard("tab-list-scrolled-reset", true);
        this.ctx.log(
          `  · list scrolled/ambiguous: [${this.describeRows(rows)}] — closing to reset scroll`,
        );
        const preClose = await this.ctx.perception.captureRaw();
        if (
          await this.ctx.surfaceClick(
            LIST_TOGGLE_FOLDER.x,
            LIST_TOGGLE_FOLDER.y,
            "tabList",
            "close folder list (reset scroll)",
          )
        ) {
          pendingFrom = visibility;
          await this.ctx.park();
          // Pixel-verified wait: exactly as long as the close animation
          // takes, and the next OCR read never races a half-drawn list
          // (that race caused one list-toggle-unverified per trip live).
          await this.ctx.perception.regionChangedSince(preClose, LIST_PIXEL_PROBE, 900);
        } else {
          await this.ctx.park();
        }
        continue;
      }
      // Closed: make sure the chevron even exists (the folder row renders
      // it), then ONE opening click, verified by the next read.
      if (!(await this.ensureFolderRowOpen())) continue;
      await this.ctx.host.send({ op: "focus" });
      await this.ctx.harness.sleep(200);
      const preOpen = await this.ctx.perception.captureRaw();
      if (
        await this.ctx.surfaceClick(
          LIST_TOGGLE_FOLDER.x,
          LIST_TOGGLE_FOLDER.y,
          "tabList",
          "open gear folder list",
        )
      ) {
        pendingFrom = visibility;
        await this.ctx.park();
        await this.ctx.perception.regionChangedSince(preOpen, LIST_PIXEL_PROBE, 900);
      } else {
        await this.ctx.park();
      }
    }
    throw new Error("gear-folder-list-unreadable");
  }

  /**
   * Close whatever list is open, verified. In the personal layout ONE
   * physical dropdown exists and the folder chevron is its only toggle —
   * whatever a scrolled read claims the window shows, closing means clicking
   * that chevron (the old top-toggle click at (1287,212) aimed at a control
   * that does not render here). Guild mode keeps its real top toggle. Each
   * close is verified by a re-read; one retry, then give up loudly and let
   * the caller's flow recover.
   */
  private async closeTabListIfOpen(): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const rows = await this.ctx.kit.readTabList();
      if (!this.ctx.harness.guard("dropdown-stayed-open", rows.length >= 4)) return;
      this.folderListOpen = false;
      const toggle = this.ctx.guildChest ? LIST_TOGGLE_TOP : LIST_TOGGLE_FOLDER;
      await this.ctx.surfaceClick(toggle.x, toggle.y, "tabList", "close tab list");
      await this.ctx.park();
      await this.ctx.harness.sleep(600);
    }
    if ((await this.ctx.kit.readTabList()).length >= 4) {
      this.ctx.harness.guard("list-close-unverified", true);
      this.ctx.log("  ! tab list did not close after two verified attempts — leaving it to recovery");
    }
  }

  /** True while the folder side list is verifiably open. The cached-row fast
   * path clicks list coordinates WITHOUT re-reading the list, so it may only
   * fire while this is true — the top-list flows CLOSE the folder list (one
   * physical dropdown), and clicking a remembered row with no list open
   * would click into the game world. */
  private folderListOpen = false;

  /** Reference frame of the dropdown region captured while the folder list
   * was verifiably OPEN (rows read, context proven). The rows never move,
   * so "the list is showing" can be re-proven by pixel similarity alone —
   * only the selected row's highlight differs between visits (~5% of the
   * region), while a closed list shows game world (a wholly different
   * frame). This is what makes the trip cycle's reopen cheap: the full
   * OCR-verified reopen measured 30-40s per trip. */
  private folderListOpenRef: RawFrame | undefined;

  /**
   * Fast reopen of the folder list against the open-state reference: if the
   * region already matches, the list is open (a strip hop merely lost the
   * observation); otherwise ONE chevron click, then poll until the region
   * matches the reference. Anything else falls back to the slow
   * OCR-verified openFolderList. Match threshold 0.10: a moved row
   * highlight differs ~5%, open-vs-world differs far more.
   */
  private async reopenFolderListFast(): Promise<boolean> {
    if (!this.ctx.folderRowsCache || !this.folderListOpenRef) return false;
    const ref = this.folderListOpenRef;
    const fractionVs = async (): Promise<number> => {
      const frame = await this.ctx.perception.captureRaw();
      return regionChangedFraction(ref.gray, frame.gray, frame.client, LIST_PIXEL_PROBE);
    };
    if ((await fractionVs()) < 0.1) {
      this.folderListOpen = true;
      return true;
    }
    if (
      !(await this.ctx.surfaceClick(
        LIST_TOGGLE_FOLDER.x,
        LIST_TOGGLE_FOLDER.y,
        "tabList",
        "reopen gear folder list",
      ))
    ) {
      return false;
    }
    await this.ctx.park();
    const deadline = Date.now() + 1000;
    let fraction = 1;
    for (;;) {
      fraction = await fractionVs();
      if (fraction < 0.1) {
        this.ctx.harness.guard("folder-list-fast-reopen", true);
        this.folderListOpen = true;
        return true;
      }
      if (Date.now() >= deadline) break;
      await this.ctx.harness.sleep(150, false);
    }
    // The pixels do not match the stored open-state frame — but the list
    // may simply LOOK different now (moved highlight, drifted appearance).
    // One OCR read settles it far cheaper than the 36s slow path measured
    // per trip (2026-09-01); a genuine non-open falls through to that path.
    const rows = await this.ctx.kit.readTabList();
    const visibility = classifyListRead(rows.length, this.listContext(rows));
    this.ctx.log(
      `  · fast reopen: ref-match ${(fraction * 100).toFixed(1)}% off, read says ${visibility} (${rows.length} rows)`,
    );
    if (visibility === "folder") {
      this.ctx.harness.guard("folder-list-reopen-by-read", true);
      this.folderListOpen = true;
      this.folderListOpenRef = await this.ctx.perception.captureRaw(); // adopt the new look
      this.ctx.folderRowsCache = rows.filter(
        (row) => !(row.readable && this.isTopLevelRowLabel(row.label)),
      );
      return true;
    }
    return false; // slow path re-proves state
  }

  /**
   * Resolve a folder-list row for `label`#`occurrence` from `rows`, with the
   * full matcher stack: exact folded > loose (with canonical-collision
   * exclusion) > remembered absolute Y > elimination. Returns undefined when
   * nothing safe matches.
   */
  private matchFolderRow(
    rows: readonly TabListRow[],
    label: string,
    occurrence: number,
  ): TabListRow | undefined {
    const cacheKey = `${label}#${occurrence}`;
    // EXACT (confusable-folded) matches outrank loose similarity, and a
    // row exactly naming a DIFFERENT known tab can never be a loose
    // match — "QuarterStaff" contains "staff" and once swallowed every
    // Staff deposit.
    const exact = rows.filter(
      (candidate) => candidate.readable && labelsEqualFolded(candidate.label, label),
    );
    // The exclusion below only makes sense when WE know exactly which
    // canonical tab we want — a garbled queue label ("Bunker/Sheildsl")
    // must still loose-match the real row it garbled from.
    const wantedIsCanonical = GEAR_TAB_NAMES.some((name) => labelsEqualFolded(name, label));
    const matches = exact.length > 0
      ? exact
      : rows.filter(
          (candidate) =>
            candidate.readable &&
            labelsSimilar(candidate.label, label) &&
            !(
              wantedIsCanonical &&
              GEAR_TAB_NAMES.some(
                (name) =>
                  !labelsEqualFolded(name, label) && labelsEqualFolded(candidate.label, name),
              )
            ),
        );
    let row: TabListRow | undefined = matches[occurrence];
    if (!row) {
      // Fall back to the remembered ABSOLUTE Y when the label merely
      // failed to OCR this frame — unless a DIFFERENT readable label now
      // sits at that position (the list changed; do not click blind).
      const cachedY = this.rowYCache.get(cacheKey);
      const near = cachedY === undefined
        ? undefined
        : rows.find((candidate) => Math.abs(candidate.clickY - cachedY) < 24);
      // Only a SUBSTANTIAL different label at the remembered position
      // blocks the click — single-char OCR debris ("O" is how Sceptre's
      // row usually reads) is the very garble the cache exists to ride
      // through, not evidence the list moved.
      const conflicting =
        near?.readable === true &&
        normalizeTabLabel(near.label).length >= 2 &&
        !labelsSimilar(near.label, label);
      if (this.ctx.harness.guard("row-y-cache-used", cachedY !== undefined && !conflicting)) {
        this.ctx.log(`  · "${label}" unreadable this frame — using its remembered y=${cachedY}`);
        row = { index: near?.index ?? -1, label, readable: false, clickY: cachedY! };
      }
    }
    if (!row && occurrence === 0 && GEAR_TAB_NAMES.some((name) => labelsSimilar(name, label))) {
      // Match by ELIMINATION: the folder's membership is fully known, so
      // when every other row claims a known gear tab and exactly ONE row
      // is unclaimed garble, that row must be the missing tab (Sceptre's
      // row OCRs as a bare "O" more often than not).
      const unclaimed = rows.filter(
        (candidate) => !GEAR_TAB_NAMES.some((name) => labelsSimilar(candidate.label, name)),
      );
      if (unclaimed.length === 1 && this.ctx.harness.guard("row-by-elimination", true)) {
        const only = unclaimed[0]!;
        this.ctx.log(
          `  · "${label}" matched by elimination — the only unclaimed row (reads "${only.readable ? only.label : "?"}") at y=${only.clickY}`,
        );
        row = { ...only, label, readable: false };
      }
    }
    return row;
  }

  /**
   * Select a tab by label, via the FOLDER list only. `occurrence` addresses
   * duplicate labels (the folder holds two tabs that read "Rings"): 0 = the
   * first matching row top-to-bottom, 1 = the second, and so on. Remove-only
   * tabs are refused outright (standing rule). Returns false when the tab
   * cannot be reached — the caller decides whether that kills the route.
   *
   * Fast paths (bench: goto averaged 9.9s over 273 hops, ~45min/session):
   * - Already the active tab → one pixel proof the grid is on screen, done.
   * - Cached folder rows + grid visible → click the remembered row and
   *   verify the switch by pixel change-detection; any doubt falls through
   *   to the slow OCR-verified path, which also refreshes the cache.
   */
  async gotoTab(
    label: string,
    occurrence = 0,
    topLevel = false,
    rowY?: number,
    drain = false,
    shop = false,
  ): Promise<boolean> {
    // Symmetric refusals: a drain goto may ONLY select a drainable
    // Remove-only row; every other goto keeps refusing them exactly as
    // before. Both directions guard against garbled labels selecting the
    // wrong kind of tab.
    if (drain && (!topLevel || !isDrainableRemoveOnlyLabel(label))) {
      this.ctx.harness.guard("drain-goto-refused", true);
      this.ctx.log(`  ! drain navigation requires a top-level Remove-only label — refusing "${label}"`);
      return false;
    }
    // A shop goto mirrors the drain shape: it may select the ONE designated
    // (usually priced) top-level tab on the personal chest, nothing else.
    if (shop && (!topLevel || drain || this.ctx.guildChest)) {
      this.ctx.harness.guard("shop-goto-refused", true);
      this.ctx.log(`  ! shop navigation is top-level personal-chest only — refusing "${label}"`);
      return false;
    }
    if (!drain && isRemoveOnlyTabLabel(label)) {
      this.ctx.harness.guard("remove-only-refused", true);
      this.ctx.log(`  ! refusing to select Remove-only tab "${label}"`);
      return false;
    }
    if (topLevel) return this.gotoTopTab(label, rowY, drain, occurrence, shop);
    const cacheKey = `${label}#${occurrence}`;
    const endPhase = this.ctx.harness.startPhase(`goto:${cacheKey}`);
    try {
      await this.ctx.harness.checkpoint(`goto ${label}`);
      // Already active: the run loop probes a tab and cleanTab immediately
      // re-navigates to it — that second hop needs one cheap grid proof.
      if (this.ctx.lastSelected === cacheKey && (await this.stashOpenProof())) {
        endPhase("already-active");
        return true;
      }
      let cachedRow = this.ctx.folderRowsCache
        ? this.matchFolderRow(this.ctx.folderRowsCache, label, occurrence)
        : undefined;
      // The list may be CLOSED (every Dump return loses the observation) —
      // the pixel-reference reopen restores it without the 30-40s OCR
      // chain. Failure just clears the fast path; the slow path re-proves.
      // A successful reopen may refresh the row cache, so re-match after.
      if (cachedRow && !this.folderListOpen) {
        cachedRow =
          (await this.reopenFolderListFast()) && this.ctx.folderRowsCache
            ? this.matchFolderRow(this.ctx.folderRowsCache, label, occurrence)
            : undefined;
      }
      // One capture serves both the stash proof and the switch baseline. A
      // dense quad defeats the lattice check (which is why the fast path
      // never fired from Dump) — a fresh positive proof stands in for it.
      const fastBefore =
        cachedRow && !isRemoveOnlyTabLabel(cachedRow.label) ? await this.ctx.perception.captureRaw() : undefined;
      if (
        cachedRow &&
        fastBefore &&
        (this.ctx.perception.stashRecentlyProven() || (await this.ctx.perception.stashGridVisible(fastBefore)))
      ) {
        if (
          !(await this.ctx.surfaceClick(
            LIST_ROW_CLICK_X,
            cachedRow.clickY,
            "tabList",
            `select tab ${label} (cached row)`,
          ))
        ) {
          // The cached Y drifted off the list surface — the cache is poison.
          this.ctx.folderRowsCache = undefined;
          this.folderListOpen = false;
        } else {
          const wasSelected = this.ctx.lastSelected;
          this.ctx.lastSelected = cacheKey;
          await this.ctx.park();
          const observed = await this.observeTabSwitch(fastBefore, true);
          // The fast path accepts only POSITIVE proof: the grid repainted and
          // is still a grid. Anything less (no repaint seen, grid gone) means
          // the click may have missed a closed list — re-prove the slow way
          // before anything deposits into a wrong tab.
          if (observed === "changed" && (await this.ctx.perception.stashGridVisible())) {
            if (cachedRow.readable) this.rowYCache.set(cacheKey, cachedRow.clickY);
            endPhase("cached-row");
            return true;
          }
          this.ctx.harness.guard("goto-fast-path-miss", true);
          this.ctx.folderRowsCache = undefined;
          this.folderListOpen = false;
          this.ctx.lastSelected = wasSelected;
        }
      }
      let switchMisses = 0;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await this.ctx.harness.checkpoint(`goto ${label}`);
        if (!this.ctx.perception.stashRecentlyProven() && !(await this.ctx.perception.stashTitleVisible())) {
          if (!(await this.ensureStash())) throw new Error("stash-lost-and-unrecoverable");
        }
        let rows: TabListRow[];
        try {
          rows = await this.openFolderList();
        } catch {
          continue; // list unreadable — retry from the top
        }
        this.ctx.folderRowsCache = rows;
        const row = this.matchFolderRow(rows, label, occurrence);
        if (!row && this.ctx.lastSelected === cacheKey) {
          // Some tab highlights (Jewels' magenta) defeat OCR while the tab is
          // ACTIVE — and the tab we last selected is still the active one, so
          // there is nothing to click. Verify the grid and stay put.
          this.ctx.harness.guard("already-selected-fallback", true);
          this.ctx.log(`  · "${label}" is the active tab (row unreadable while highlighted) — staying`);
          await this.ctx.perception.settleGrid();
          endPhase("already-selected");
          return true;
        }
        if (!row) {
          // The folder list is short and unclipped; a missing row is a bad
          // read, not a scrolled-away tab. Close and retry.
          this.ctx.log(`  · "${label}"#${occurrence} not in folder list: [${this.describeRows(rows)}]`);
          this.ctx.folderRowsCache = undefined;
          await this.closeTabListIfOpen();
          continue;
        }
        if (row.readable) this.rowYCache.set(cacheKey, row.clickY);
        if (isRemoveOnlyTabLabel(row.label)) {
          this.ctx.harness.guard("remove-only-refused", true);
          this.ctx.log(`  ! folder list row for "${label}" reads Remove-only — refusing`);
          endPhase("refused");
          return false;
        }
        const before = await this.ctx.perception.captureRaw(); // switch baseline, pre-click
        if (
          !(await this.ctx.surfaceClick(LIST_ROW_CLICK_X, row.clickY, "tabList", `select tab ${label}`))
        ) {
          this.ctx.folderRowsCache = undefined;
          continue; // the row Y is off the list surface — re-read, never send
        }
        const wasSelected = this.ctx.lastSelected;
        const expectChange = wasSelected !== cacheKey;
        this.ctx.lastSelected = cacheKey;
        await this.ctx.park();
        // The folder list sits to the RIGHT of the stash panel and obstructs
        // nothing — leave it open between hops (the user asked for exactly
        // this: only a top-level list ever needs closing).
        const observed = await this.observeTabSwitch(before, expectChange);
        if (expectChange && observed === "unchanged") {
          // The probe covers the strip AND the grid top: a real switch moves
          // the header highlight even when two near-empty grids are pixel-
          // identical, so "unchanged" now means the click did nothing
          // observable. The one legitimate case is an unknown active tab
          // (session start / post-recovery) that already WAS the wanted tab.
          if (wasSelected === undefined && switchMisses === 0) {
            this.ctx.harness.guard("tab-select-blind-accept", true);
          } else {
            // We KNEW a different tab was active — diagnose, never believe:
            // re-read next attempt, and after two misses run the full-screen
            // stash diagnosis (pause menu, toast over the title, panel
            // closed all have known signatures there).
            switchMisses += 1;
            this.ctx.harness.guard("tab-select-unobserved", true);
            this.ctx.lastSelected = undefined; // honest: the active tab is unknown now
            this.ctx.folderRowsCache = undefined;
            this.folderListOpen = false;
            this.ctx.lastStashProofAt = 0; // an unobserved click ends the trust

            if (switchMisses >= 2 && !(await this.ensureStash())) {
              throw new Error("stash-lost-and-unrecoverable");
            }
            continue;
          }
        }
        endPhase();
        return true;
      }
      endPhase("unreachable");
      return false;
    } catch (error) {
      endPhase(error instanceof SortStop ? "stopped" : "failed");
      throw error;
    }
  }

  /**
   * Close the top list without an OCR round trip when possible: the list was
   * verifiably open moments ago (its rows were just read or clicked), so one
   * toggle click closes it; the pixel change on the list region plus a grid
   * proof confirm. Any doubt falls back to the OCR-verified close.
   */
  async closeTopListFast(): Promise<void> {
    const listRegion = {
      x: TAB_LIST.region.left,
      y: TAB_LIST.region.top,
      w: 700,
      h: TAB_LIST.region.height,
    };
    await this.ctx.surfaceClick(LIST_TOGGLE_TOP.x, LIST_TOGGLE_TOP.y, "tabList", "close top-level tab list");
    await this.ctx.park();
    // Wait for the close animation to finish (stability), then prove the
    // grid is showing. The toggle click happened before the pixwait baseline,
    // so only stability is meaningful here — the grid proof is the verdict.
    await this.ctx.perception.pixwait(listRegion, { stableMs: 150 });
    if (await this.ctx.perception.stashGridVisible()) return;
    this.ctx.harness.guard("top-list-close-unverified", true);
    await this.closeTabListIfOpen();
  }

  /** Verified strip-header click points per top-level label. The strip
   * never moves in the no-overflow layout, so a return hop clicks the
   * remembered point directly instead of re-running the 2.5s settledOcr
   * strip read every trip (Dump returns measured 11.5s each; the cached
   * click verifies exactly like any select — pre-click baseline + observed
   * repaint — and any doubt falls back to the full strip path). */
  private readonly topHeaderPoints = new Map<string, { x: number; y: number }>();

  private topStripDisambiguated = false;

  /**
   * The top-list toggle only RENDERS in overflow layouts. T tabs on the
   * strip are the live evidence of one; without it (the current no-overflow
   * layout: Dump, Gear, AFFINITIES, Extra) the toggle's coordinate is a dead
   * click — worse, it sits inside the top strip band and could select a tab.
   * The guild chest is always overflowed.
   */
  private get topListEvidence(): boolean {
    return this.ctx.guildChest || [...this.ctx.knownTopLabels].some((label) => isTTabLabel(label));
  }

  private canonTopLabel(label: string): string {
    return canonicalTTabLabel(label) ?? normalizeTabLabel(label);
  }

  noteTopStrip(entries: readonly StripEntry[]): void {
    for (const entry of entries) {
      const canon = this.canonTopLabel(entry.label);
      if (canon.length >= 2) this.ctx.knownTopLabels.add(canon);
    }
  }

  /** Top-strip entries that are safe to CLICK (real tabs, not folders or
   * protected tabs). A drain goto inverts the Remove-only rule: it may ONLY
   * click Remove-only entries (priced protection still outranks it). */
  private clickableTopEntry(entry: StripEntry, drain = false, shop = false): boolean {
    const trimmed = entry.label.trim();
    if (drain) return isDrainableRemoveOnlyLabel(trimmed);
    if (shop) {
      // The designated shop tab is usually priced — the exact-match gate in
      // the caller already proved identity, so only the never-touch rules
      // remain (a garbled label reading Remove-only still refuses).
      return trimmed.length >= 2 && !isRemoveOnlyTabLabel(trimmed);
    }
    return (
      trimmed.length >= 2 &&
      !/^(gear|affinities)$/i.test(trimmed) &&
      !isRemoveOnlyTabLabel(trimmed) &&
      !trimmed.startsWith("~") &&
      !/price/i.test(trimmed)
    );
  }

  /**
   * Selection of a top-level tab by its own STRIP HEADER — the user's chosen
   * navigation for top-level tabs and folders (2026-08-30): the strip shows
   * every label unclipped, and with no overflow the dropdown's top toggle
   * does not even render. The wanted label can be unreadable because it is
   * the ACTIVE tab (its highlight defeats OCR) — pixel elimination detects
   * that with zero clicks; failing that, ONE unmask hop to a gear tab makes
   * every header readable (once per session). Returns true on positively
   * verified selection, false on a definitive refusal, undefined when this
   * attempt proved nothing (caller retries).
   */
  private async gotoTopTabViaStrip(
    label: string,
    cacheKey: string,
    drain = false,
    shop = false,
  ): Promise<boolean | undefined> {
    const findEntry = (entries: readonly StripEntry[]): StripEntry | undefined => {
      if (shop) {
        // Shop navigation matches with labelsEqualFolded ONLY: a clipped or
        // garbled label ("rice 5 exalted") must refuse, never resolve — the
        // wrong priced tab is exactly the tab this flow must never touch.
        const hits = entries.filter((candidate) => labelsEqualFolded(candidate.label, label));
        return hits.length === 1 ? hits[0] : undefined;
      }
      return (
        pickExact(entries, label) ?? pickUnique(entries, label) ?? findLabelSegment(entries, label)
      );
    };
    let strip = await this.ctx.kit.readStrip();
    this.noteTopStrip(strip.top);
    let entry = findEntry(strip.top);
    if (entry && !this.clickableTopEntry(entry, drain, shop)) return false; // protected — refuse
    if (!entry && (drain || shop)) {
      // Remove-only and shop labels must resolve exactly; the guesswork
      // fallbacks below (bright-header elimination, the unmask hop) could
      // select a DIFFERENT tab, and neither flow may run against a guess.
      // Report nothing-proven and let the caller retry or skip the source.
      return undefined;
    }
    if (!entry) {
      // BRIGHT-HEADER elimination: a light-coloured tab (the user's Dump tab
      // is silver) NEVER OCRs — dark text on a light background defeats the
      // engine whether the tab is active or not. But that same brightness
      // makes it findable by pixels: when exactly one plausible bright
      // header exists, no readable label overlaps it, and no readable label
      // matches the wanted tab, that header must be the wanted tab. Click
      // it — a click on an already-active header is a harmless no-op.
      const raw = await this.ctx.perception.captureRaw();
      const band = {
        x: 40,
        y: STRIP_ROWS.top.min + 6,
        w: 1240,
        h: STRIP_ROWS.top.max - STRIP_ROWS.top.min - 12,
      };
      const runs = brightHeaderRuns(raw.gray, raw.client, band).filter(
        (run) => run.x1 - run.x0 <= 420,
      );
      const overlapsReadable = (run: { x0: number; x1: number }) =>
        strip.top.some(
          (candidate) =>
            candidate.point.x - candidate.width / 2 - 12 < run.x1 &&
            candidate.point.x + candidate.width / 2 + 12 > run.x0,
        );
      if (runs.length === 1 && !overlapsReadable(runs[0]!)) {
        const run = runs[0]!;
        const cx = Math.round((run.x0 + run.x1) / 2);
        const cy = Math.round((STRIP_ROWS.top.min + STRIP_ROWS.top.max) / 2);
        this.ctx.harness.guard("top-tab-by-brightness", true);
        this.ctx.log(
          `  · "${label}" has no readable header, but exactly one bright unlabeled header sits at x≈${cx} — clicking it as ${label}`,
        );
        await this.ctx.host.send({ op: "focus" });
        await this.ctx.harness.sleep(200);
        if (!(await this.ctx.surfaceClick(cx, cy, "stripTop", `select top tab ${label} (bright header)`))) {
          return undefined;
        }
        this.ctx.lastSelected = cacheKey;
        // A top-level selection changes what the ONE physical dropdown lists
        // (the active tab's container) — cached folder rows must not be
        // clicked again until a fresh read proves the folder context.
        this.folderListOpen = false;
        await this.ctx.park();
        // No repaint is legitimate here — the header may already have been
        // the active tab. The verdict is simply "is the stash still open":
        // the dense-quad case defeats the lattice check, so the panel title
        // is the fallback proof.
        await this.settleAfterTabClick(true);
        if (await this.stashOpenProof()) {
          this.topHeaderPoints.set(label, { x: cx, y: cy });
          return true;
        }
        return undefined;
      }
      if (!this.topStripDisambiguated && !this.ctx.guildChest) {
        // Last resort: hop to a known gear tab once so every top header is
        // inactive and readable, then look again. (Guild mode has no gear
        // folder to hop into — skip straight to the retry.)
        this.topStripDisambiguated = true;
        this.ctx.harness.guard("top-strip-unmask-hop", true);
        this.ctx.log(`  · "${label}" not readable in the strip — hopping to a gear tab to unmask it`);
        for (const gearTab of ["Belts", "Rings", "Helmets"]) {
          if (await this.gotoTab(gearTab)) break;
        }
        strip = await this.ctx.kit.readStrip();
        this.noteTopStrip(strip.top);
        entry = findEntry(strip.top);
        if (entry && !this.clickableTopEntry(entry)) return false;
      }
    }
    if (!entry) return undefined;
    await this.ctx.host.send({ op: "focus" });
    await this.ctx.harness.sleep(200);
    const wasSelected = this.ctx.lastSelected;
    const before = await this.ctx.perception.captureRaw(); // switch baseline, pre-click
    if (
      !(await this.ctx.surfaceClick(
        entry.point.x,
        entry.point.y,
        "stripTop",
        `select top tab ${label} (strip)`,
      ))
    ) {
      return undefined;
    }
    this.ctx.lastSelected = cacheKey;
    // See the bright-header path: a top-level selection invalidates the
    // cached folder-list context (one physical dropdown).
    this.folderListOpen = false;
    await this.ctx.park();
    const observed = await this.observeTabSwitch(before, true);
    if (observed !== "unchanged" && (await this.stashOpenProof())) {
      this.topHeaderPoints.set(label, { x: entry.point.x, y: entry.point.y });
      return true;
    }
    if (observed === "unchanged" && wasSelected === undefined && (await this.stashOpenProof())) {
      // No repaint and no highlight move with the active tab UNKNOWN
      // (session start / post-recovery): the wanted tab was very likely
      // already active, and clicking its own header repaints nothing.
      // Accept once, visibly — demanding a change here called an already-
      // active Dump "unreachable" after 35s of futile clicks (dry-run,
      // 2026-09-01).
      this.ctx.harness.guard("top-strip-blind-accept", true);
      return true;
    }
    this.ctx.harness.guard("top-strip-click-unverified", true);
    // The click proved nothing — claiming the tab is selected would let a
    // later "already-active" check trust a switch that never happened.
    this.ctx.lastSelected = wasSelected === cacheKey ? undefined : wasSelected;
    return undefined;
  }

  /**
   * Select a TOP-LEVEL tab. Named labels click their own STRIP HEADER —
   * the user's chosen navigation for top-level tabs (2026-08-30). Only
   * positional T-band rows (no readable header anywhere, addressed by their
   * remembered dropdown Y) still go through the top list, which covers the
   * grid and is always closed after selection.
   */
  async gotoTopTab(
    label: string,
    rowY?: number,
    drain = false,
    occurrence = 0,
    shop = false,
  ): Promise<boolean> {
    // The guild stash repeats labels (three "2 (Remove-only)" tabs live);
    // occurrence keys the cache and picks the nth matching list row, the
    // folder machinery's trick applied to the top level.
    const cacheKey = `top:${label}#${occurrence}`;
    const endPhase = this.ctx.harness.startPhase(`goto:${cacheKey}`);
    try {
      await this.ctx.harness.checkpoint(`goto top ${label}`);
      if (this.ctx.lastSelected === cacheKey && (await this.stashOpenProof())) {
        endPhase("already-active");
        return true;
      }
      // Guild mode navigates EVERYTHING through the list: the strip shows
      // only a couple of headers in the overflowed guild layout, and the
      // strip path's guess fallbacks must never pick a deposit target.
      if (!this.ctx.guildChest && !label.startsWith("T@row") && rowY === undefined) {
        // Cached header point first — the strip never moves, and the full
        // path's settledOcr read cost every Dump return ~11.5s live.
        const cachedPoint = this.topHeaderPoints.get(label);
        if (cachedPoint && !drain) {
          await this.ctx.host.send({ op: "focus" });
          await this.ctx.harness.sleep(200);
          const wasSelected = this.ctx.lastSelected;
          const before = await this.ctx.perception.captureRaw();
          if (
            await this.ctx.surfaceClick(
              cachedPoint.x,
              cachedPoint.y,
              "stripTop",
              `select top tab ${label} (cached header)`,
            )
          ) {
            this.ctx.lastSelected = cacheKey;
            this.folderListOpen = false; // one physical dropdown (see viaStrip)
            await this.ctx.park();
            const observed = await this.observeTabSwitch(before, true);
            if (
              observed === "changed" &&
              (this.ctx.perception.stashRecentlyProven() || (await this.stashOpenProof()))
            ) {
              endPhase("cached-header");
              return true;
            }
          }
          // Doubt: forget the point and re-derive it the slow, verified way.
          this.ctx.harness.guard("top-header-cache-miss", true);
          this.topHeaderPoints.delete(label);
          this.ctx.lastSelected = wasSelected === cacheKey ? undefined : wasSelected;
        }
        for (let attempt = 0; attempt < 3; attempt += 1) {
          await this.ctx.harness.checkpoint(`goto top ${label}`);
          const viaStrip = await this.gotoTopTabViaStrip(label, cacheKey, drain, shop);
          if (viaStrip !== undefined) {
            endPhase(viaStrip ? "strip" : "refused");
            return viaStrip;
          }
          // Nothing proven this attempt — make sure the stash is even open
          // before reading the strip again.
          if (!this.ctx.perception.stashRecentlyProven() && !(await this.ctx.perception.stashTitleVisible())) {
            if (!(await this.ensureStash())) throw new Error("stash-lost-and-unrecoverable");
          }
        }
        endPhase("unreachable");
        return false;
      }
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await this.ctx.harness.checkpoint(`goto top ${label}`);
        if (!(await this.ctx.perception.stashTitleVisible())) {
          if (!(await this.ensureStash())) throw new Error("stash-lost-and-unrecoverable");
        }
        let rows: TabListRow[];
        try {
          rows = await this.openTopList();
        } catch {
          continue;
        }
        // The Remove-only rule inverts per goto kind: a drain goto matches
        // ONLY drainable Remove-only rows, every other goto refuses them.
        const rowSelectable = (candidate: TabListRow): boolean =>
          drain
            ? isDrainableRemoveOnlyLabel(candidate.label)
            : !isRemoveOnlyTabLabel(candidate.label);
        // Duplicate labels: exact matches are picked by OCCURRENCE (nth
        // row top-to-bottom). The loose-similarity fallback is only safe
        // for occurrence 0 and NEVER for drains — the guild's numeric
        // labels containment-match each other ("1 (Remove-only)" is inside
        // "31 (Remove-only)"), and a drain must not select a lookalike.
        const exact = rows.filter(
          (candidate) =>
            candidate.readable &&
            rowSelectable(candidate) &&
            labelsEqualFolded(candidate.label, label),
        );
        let row: TabListRow | undefined =
          exact[occurrence] ??
          (occurrence === 0 && !drain
            ? rows.find(
                (candidate) =>
                  candidate.readable &&
                  rowSelectable(candidate) &&
                  labelsSimilar(candidate.label, label),
              )
            : undefined);
        if (!row) {
          // A positional source (unreadable T-band row) or a remembered Y:
          // click the absolute position, unless a readable protected label
          // now sits there. A drain source's row must additionally still
          // read Remove-only if it reads at all — Remove-only tabs VANISH
          // when fully drained, so a stale Y may point at a shifted row.
          const targetY = this.rowYCache.get(cacheKey) ?? rowY;
          const near = targetY === undefined
            ? undefined
            : rows.find((candidate) => Math.abs(candidate.clickY - targetY) < 24);
          const conflicting =
            (near?.readable === true &&
              normalizeTabLabel(near.label).length >= 2 &&
              !labelsSimilar(near.label, label) &&
              !canonicalTTabLabel(near.label)) ||
            (drain && near?.readable === true && !isDrainableRemoveOnlyLabel(near.label)) ||
            (drain && !near);
          if (this.ctx.harness.guard("row-y-cache-used", targetY !== undefined && !conflicting)) {
            this.ctx.log(`  · "${label}" unreadable this frame — using y=${targetY}`);
            row = { index: near?.index ?? -1, label, readable: false, clickY: targetY! };
          }
        }
        if (!row && this.ctx.lastSelected === cacheKey) {
          this.ctx.harness.guard("already-selected-fallback", true);
          this.ctx.log(`  · "${label}" is the active tab (row unreadable while highlighted) — staying`);
          await this.closeTopListFast();
          endPhase("already-selected");
          return true;
        }
        if (!row) {
          this.ctx.log(`  · "${label}" not in top list: [${this.describeRows(rows)}]`);
          await this.closeTabListIfOpen();
          continue;
        }
        if (row.readable) this.rowYCache.set(cacheKey, row.clickY);
        if (
          !(await this.ctx.surfaceClick(
            LIST_ROW_CLICK_X,
            row.clickY,
            "tabList",
            `select top tab ${label}`,
          ))
        ) {
          continue; // the row Y is off the list surface — re-read, never send
        }
        this.ctx.lastSelected = cacheKey;
        await this.ctx.park();
        await this.ctx.harness.sleep(300);
        // The TOP list covers the grid — always close it after selecting.
        await this.closeTopListFast();
        // Guild tab switches are realm writes too — hold the floor.
        if (this.ctx.guildChest) await this.ctx.harness.sleep(GUILD_PACE.tabMs, false);
        endPhase();
        return true;
      }
      endPhase("unreachable");
      return false;
    } catch (error) {
      endPhase(error instanceof SortStop ? "stopped" : "failed");
      throw error;
    }
  }

  /**
   * Enumerate the sortable top-level T* tabs from the live top list, plus
   * synthesized T1..T16 candidates for rows whose labels do not OCR (short
   * labels routinely read as blank) — the goto probe sorts out which of
   * those actually exist. Remove-only rows are excluded outright; folders
   * (Gear, AFFINITIES) never match the T pattern.
   */
  async listTopSources(): Promise<SourceTab[]> {
    const sources: SourceTab[] = [];
    const seen = new Set<string>();
    // Every readable top-level tab is a source (the user adds plain storage
    // tabs the T* pattern can't predict) EXCEPT protected ones: ~price tabs
    // carry public listings that moving items would delist, the Gear row is
    // a folder rather than a tab, and AFFINITIES has its own semantics.
    const admit = (label: string): boolean => {
      if (!label || isRemoveOnlyTabLabel(label)) return false;
      const lower = label.toLowerCase();
      if (lower.startsWith("~") || lower.includes("price") || lower === "gear" || lower === "affinities") {
        return false;
      }
      if (normalizeTabLabel(label).length < 2) return false; // OCR debris
      const canonical = canonicalTTabLabel(label) ?? lower;
      if (seen.has(canonical)) return false;
      seen.add(canonical);
      return true;
    };
    // STRIP-FIRST: a no-overflow top row (the user's 2026-08-30 tab rework)
    // shows every label unclipped and renders NO top-list toggle at all —
    // the list path cannot even open there. The ACTIVE tab's label may be
    // missing here (highlight defeats OCR); run()'s requested-source probe
    // plus the goto unmask hop cover it.
    const strip = await this.ctx.kit.readStrip();
    this.noteTopStrip(strip.top);
    for (const entry of strip.top) {
      const label = entry.label.trim();
      if (admit(label)) sources.push({ label, occurrence: 0, topLevel: true });
    }
    // The dropdown still adds scrolled-off tabs and the positional T band in
    // OVERFLOW layouts — evidenced by the strip showing T tabs at all. In a
    // no-overflow layout (the current one) the toggle does not exist, every
    // attempt would be a dead click, and the strip row above is complete.
    let rows: TabListRow[] = [];
    if (strip.top.some((entry) => isTTabLabel(entry.label))) {
      try {
        rows = await this.openTopList(2);
      } catch {
        this.ctx.harness.guard("top-list-unavailable", true);
        rows = [];
      }
    }
    for (const row of rows) {
      if (!row.readable) continue;
      const label = row.label.trim();
      if (admit(label)) sources.push({ label, occurrence: 0, topLevel: true });
    }
    // The T tabs' SHORT labels are chronically unreadable, and synthesizing
    // T1..T16 by NAME queued ghosts that can never be clicked. Instead queue
    // the UNREADABLE rows positionally — but only inside the T band: strictly
    // after the AFFINITIES (or Gear) row and before the first readable row
    // that is not a T tab. Protected tabs (Remove-only, ~price, specials)
    // all have long, readable labels and sit outside the band, so a blind
    // positional click cannot land on one.
    const anchor = rows.find((row) => row.readable && /^(affinities|gear)$/i.test(row.label.trim()));
    if (anchor) {
      const anchorAt = rows.findIndex((row) => row === anchor);
      for (let i = anchorAt + 1; i < rows.length; i += 1) {
        const row = rows[i]!;
        if (row.readable) {
          const trimmed = row.label.trim();
          if (/^(affinities|gear)$/i.test(trimmed)) continue;
          if (canonicalTTabLabel(trimmed)) continue; // readable T rows already queued
          break; // first readable non-T row ends the band
        }
        const label = `T@row${row.index}`;
        if (seen.has(label)) continue;
        seen.add(label);
        sources.push({ label, occurrence: 0, topLevel: true, rowY: row.clickY });
      }
    }
    if (rows.length > 0) await this.closeTabListIfOpen();
    return sources;
  }

  /**
   * Enumerate Remove-only tabs as DRAIN sources (withdraw-only; the
   * 2026-08-30 rule change). Strip first — but in an OVERFLOWED layout the
   * Remove-only tabs sit at the END of the top list, exactly the rows the
   * strip cannot show, so the top list is always attempted too. Its absence
   * (no-overflow layout: the toggle does not render) proves the strip
   * already showed everything. Labels are long and OCR-readable; rows that
   * do not read are NOT synthesized — a drain never runs on a guessed tab.
   * A fully drained Remove-only tab vanishes from the account, so any tab
   * enumerated here may legitimately be gone by the time it is visited.
   */
  async listRemoveOnlySources(): Promise<SourceTab[]> {
    const admit = (label: string): boolean =>
      isDrainableRemoveOnlyLabel(label.trim()) && normalizeTabLabel(label.trim()).length >= 2;
    // LIST FIRST: in an overflowed layout the Remove-only tabs sit at the
    // END of the top list — exactly the rows the strip cannot show — and
    // the list gives every row a position, which duplicate labels need
    // (the guild repeats "2 (Remove-only)" three times; occurrence picks
    // the nth row, rowY remembers where it was).
    const sources: SourceTab[] = [];
    try {
      const rows = await this.openTopList(2);
      const counts = new Map<string, number>();
      for (const row of rows) {
        if (!row.readable || !admit(row.label)) continue;
        const label = row.label.trim();
        const canon = normalizeTabLabel(label);
        const occurrence = counts.get(canon) ?? 0;
        counts.set(canon, occurrence + 1);
        sources.push({ label, occurrence, topLevel: true, drain: true, rowY: row.clickY });
      }
      await this.closeTabListIfOpen();
      if (sources.length > 0) return sources;
    } catch {
      this.ctx.log("  · top list did not open (no-overflow layout) — falling back to the strip");
    }
    // Strip fallback for no-overflow layouts (the toggle does not render
    // there, and the strip shows every label unclipped, without duplicates
    // hidden behind it).
    const strip = await this.ctx.kit.readStrip();
    this.noteTopStrip(strip.top);
    const seen = new Set<string>();
    for (const entry of strip.top) {
      const label = entry.label.trim();
      if (!admit(label)) continue;
      const canon = normalizeTabLabel(label);
      if (seen.has(canon)) continue;
      seen.add(canon);
      sources.push({ label, occurrence: 0, topLevel: true, drain: true });
    }
    return sources;
  }

  /**
   * Get the TOP-LEVEL list open and read its rows — the folder list's mirror
   * image. QUARANTINED to layouts that can satisfy it (dump-sort handoff
   * item 2): guild chest, or a personal strip that has shown T tabs. In the
   * strip-only layout the toggle does not render and every attempt would be
   * a dead click — the caller's strip path covers everything there. Same
   * verified one-click toggle discipline as openFolderList.
   */
  async openTopList(attempts = 8): Promise<TabListRow[]> {
    if (!this.topListEvidence) {
      this.ctx.harness.guard("top-list-toggle-absent", true);
      throw new Error("top-list-toggle-not-rendered");
    }
    if (!(await this.ctx.perception.stashTitleVisible())) throw new Error("stash-panel-closed");
    // There is ONE physical dropdown: getting the top list open means the
    // folder list is (or is about to be) closed — the folder fast path must
    // not click remembered rows after this.
    this.folderListOpen = false;
    await this.ctx.park(); // no tooltip over the list region (see openFolderList)
    let pendingFrom: ListVisibility | undefined;
    let unverifiedToggles = 0;
    let unreadableReads = 0;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const rows = await this.ctx.kit.readTabList();
      let visibility = classifyListRead(rows.length, this.listContext(rows));
      if (visibility === "unreadable") {
        unreadableReads += 1;
        if (unreadableReads < 2) {
          await this.ctx.harness.sleep(400, false);
          continue;
        }
        visibility = "closed";
      }
      unreadableReads = 0;
      if (pendingFrom !== undefined && visibility === pendingFrom) {
        this.ctx.harness.guard("list-toggle-unverified", true);
        unverifiedToggles += 1;
        if (unverifiedToggles >= 2) {
          if (!(await this.ensureStash())) throw new Error("stash-lost-and-unrecoverable");
          unverifiedToggles = 0;
          pendingFrom = undefined;
          continue;
        }
      } else {
        unverifiedToggles = 0;
      }
      pendingFrom = undefined;
      if (decideListToggle(visibility, "top-level") === "none") return rows;
      if (visibility === "folder") {
        if (
          await this.ctx.surfaceClick(
            LIST_TOGGLE_FOLDER.x,
            LIST_TOGGLE_FOLDER.y,
            "tabList",
            "close gear folder list",
          )
        ) {
          pendingFrom = visibility;
        }
        await this.ctx.park();
        await this.ctx.harness.sleep(700);
        continue;
      }
      if (visibility === "ambiguous-open") {
        // Stable scrolled state showing only special tabs — close so the
        // reopen below resets the scroll (see openFolderList).
        this.ctx.harness.guard("tab-list-ambiguous", true);
        this.ctx.log(`  · list read ambiguous: [${this.describeRows(rows)}] — closing to reset scroll`);
        if (
          await this.ctx.surfaceClick(
            LIST_TOGGLE_TOP.x,
            LIST_TOGGLE_TOP.y,
            "tabList",
            "close scrolled tab list",
          )
        ) {
          pendingFrom = visibility;
        }
        await this.ctx.park();
        await this.ctx.harness.sleep(700);
        continue;
      }
      // Closed: one opening click, verified by the next read.
      await this.ctx.host.send({ op: "focus" });
      await this.ctx.harness.sleep(200);
      if (
        await this.ctx.surfaceClick(
          LIST_TOGGLE_TOP.x,
          LIST_TOGGLE_TOP.y,
          "tabList",
          "open top-level tab list",
        )
      ) {
        pendingFrom = visibility;
      }
      await this.ctx.park();
      await this.ctx.harness.sleep(900);
    }
    throw new Error("top-level-list-unreadable");
  }
}
