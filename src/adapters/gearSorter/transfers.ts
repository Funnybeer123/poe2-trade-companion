/**
 * Gear sorter — item transfers: bounce-verified deposits, verified-serial
 * guild/shop withdrawals, junk cascades and the end-of-run bag finish.
 * Split out of gearSorter.ts mechanically; the orchestrator (GearSorter)
 * owns the shared state and hands it over through SorterContext.
 */
import type { TabListRow } from "../stashTabKit.js";
import { SortStop } from "../sortHarness.js";
import { isRemoveOnlyTabLabel } from "../../core/stashTabAdmin.js";
import {
  bagCompletionVerdict,
  describeBagLeftovers,
  isTTabLabel,
  type GridCell,
  type IdentifiedItem,
} from "../../core/gearSort.js";
import { LIST_ROW_CLICK_X, GUILD_PACE } from "./context.js";
import type { SourceTab, SorterContext } from "./context.js";

export class Transfers {
  constructor(private readonly ctx: SorterContext) {}

  private readonly stuckObservations = new Map<string, Set<string>>();

  /* ---------------- deposit ---------------- */

  /** Bag cells that are still worth clicking (not known-undepositable). */
  depositTargets(cells: readonly GridCell[]): GridCell[] {
    return cells.filter((cell) => !this.ctx.undepositableBag.has(`${cell.row},${cell.col}`));
  }

  /** A cell bounced (plain AND shifted) in this tab; two different tabs = blacklist. */
  private markStuck(cells: readonly GridCell[], destLabel: string): void {
    for (const cell of cells) {
      const key = `${cell.row},${cell.col}`;
      const seen = this.stuckObservations.get(key) ?? new Set<string>();
      seen.add(destLabel);
      this.stuckObservations.set(key, seen);
      if (seen.size >= 2 && !this.ctx.undepositableBag.has(key)) {
        this.ctx.undepositableBag.add(key);
        this.ctx.log(
          `  · bag cell ${key} undepositable in ${[...seen].join(" and ")} — leaving it alone (quest item?)`,
        );
      }
    }
  }

  /* ---------------- foreign-item purge ---------------- */

  /** The T tab that most recently accepted junk — tried first so a junk trip
   * usually needs no list enumeration at all. */
  private lastJunkTab: string | undefined;

  /**
   * Deposit specific bag cells into the ACTIVE tab: plain ctrl-clicks, one
   * shift+ctrl retry for affinity bounces, stuck-marking for the rest.
   */
  /**
   * Verified-serial withdrawal for the guild stash: ONE ctrl-click at a
   * time, the next only after the bag pixel-verifiably GREW (the item
   * committed). No growth within the timeout = rollback/refusal — that is
   * a STOP signal for the batch (pace down, let the next round re-verify
   * state), never a retry hammer. Returns the items that actually left.
   */
  async guildWithdrawSerial(
    batch: readonly IdentifiedItem[],
    leaving: readonly IdentifiedItem[],
    key: string,
  ): Promise<IdentifiedItem[]> {
    const withdrawn: IdentifiedItem[] = [];
    const paceMs = () => Math.round(GUILD_PACE.itemMs * Math.max(1, this.ctx.harness.pace));
    for (const item of batch) {
      const before = await this.ctx.perception.bagCount();
      const sent = await this.ctx.harness.burst([item.cells[0]!], {
        found: leaving.flatMap((entry) => entry.cells),
        cellW: 56,
        cellH: 56,
        label: `guild withdraw ${withdrawn.length + 1}/${batch.length} (${key})`,
      });
      if (sent === 0) return withdrawn; // rejected or dry-run
      // Poll for the commit: the bag grew. Unpaced reads — the pacing
      // interval below is the rate limiter, not these.
      let committed = false;
      const deadline = Date.now() + GUILD_PACE.commitTimeoutMs;
      while (Date.now() < deadline) {
        await this.ctx.harness.sleep(450, false);
        if ((await this.ctx.perception.bagCount()) > before) {
          committed = true;
          break;
        }
      }
      if (!committed) {
        this.ctx.harness.guard("guild-withdraw-rollback", true);
        this.ctx.harness.paceDown();
        await this.ctx.step(
          `${key}: withdrawal did not commit (rollback/refusal) — stopping this batch, pace down`,
        );
        return withdrawn;
      }
      withdrawn.push(item);
      await this.ctx.harness.sleep(paceMs(), false);
    }
    return withdrawn;
  }

  /**
   * Verified-serial deposit for the guild stash: one plain ctrl-click at a
   * time (no affinities exist — the item lands in the OPEN tab, and shift
   * adds nothing), each verified by the TWO-READ bounce check before the
   * next. A bounce means the tab refused (full) — stop the group, pace
   * down; callers already treat the remainder as a full destination.
   */
  private async guildDepositSerial(points: readonly GridCell[], destLabel: string): Promise<number> {
    const paceMs = () => Math.round(GUILD_PACE.itemMs * Math.max(1, this.ctx.harness.pace));
    let remaining = [...points];
    while (remaining.length > 0) {
      const cell = remaining[0]!;
      const sent = await this.ctx.harness.burst([cell], {
        cellW: 70,
        cellH: 70,
        label: `guild deposit → ${destLabel} (${remaining.length} left)`,
      });
      if (sent === 0) return remaining.length; // rejected or dry-run
      await this.ctx.harness.sleep(700, false);
      const first = new Set((await this.ctx.perception.currentBagCells()).map((c) => `${c.row},${c.col}`));
      await this.ctx.harness.sleep(650, false);
      const second = new Set((await this.ctx.perception.currentBagCells()).map((c) => `${c.row},${c.col}`));
      const stillThere =
        first.has(`${cell.row},${cell.col}`) || second.has(`${cell.row},${cell.col}`);
      if (stillThere) {
        this.ctx.harness.guard("guild-deposit-bounced", true);
        this.ctx.harness.paceDown();
        this.ctx.log(`  · guild deposit into ${destLabel} bounced — treating it as full, pace down`);
        return remaining.length;
      }
      remaining = remaining.slice(1);
      await this.ctx.harness.sleep(paceMs(), false);
    }
    return 0;
  }

  async depositCells(
    points: readonly GridCell[],
    destLabel: string,
    options: { shiftOnly?: boolean } = {},
  ): Promise<number> {
    if (this.ctx.guildChest) return this.guildDepositSerial(points, destLabel);
    let targets = [...points];
    // shiftOnly (the shop flow): shift+ctrl targets the OPEN tab outright,
    // so a stash affinity can never divert an item away from the shop tab.
    for (let pass = options.shiftOnly ? 1 : 0; pass < 2 && targets.length > 0; pass += 1) {
      const sent = await this.ctx.harness.burst(targets, {
        cellW: 70,
        cellH: 70,
        label: `${pass === 0 ? "deposit" : "deposit (shift)"} ${targets.length} → ${destLabel}`,
        shift: pass === 1,
      });
      if (sent === 0) return targets.length; // rejected or dry-run
      // A bounced deposit (full tab) leaves the cells briefly EMPTY while
      // the items fly back to the bag (0.7-1.3s) — a read inside that
      // window called a full tab a clean deposit and re-filed the same
      // rings for whole rounds (watched live 2026-08-30). ONE read past
      // the window has the same detection power as the old 700ms+650ms
      // pair: their union rule meant the early read could only add an item
      // present at 700ms and gone at 1350ms, which no real bounce produces
      // (watcher-bot analysis #9, 2026-09-01).
      await this.ctx.harness.sleep(1450, false);
      const settled = new Set(
        (await this.ctx.perception.currentBagCells()).map((cell) => `${cell.row},${cell.col}`),
      );
      targets = targets.filter((cell) => settled.has(`${cell.row},${cell.col}`));
      if (targets.length > 0 && pass === 1) this.markStuck(targets, destLabel);
    }
    return targets.length;
  }

  /** Deposit the given bag cells into T* tabs (top-level), cascading on
   * refusal. The tab that last accepted junk is tried first (no list read);
   * further candidates come from one top-list enumeration. */
  async depositJunkCells(points: readonly GridCell[]): Promise<number> {
    // Layouts without any junk (T*) tab: once the strip has been read and
    // showed none, stop re-checking on every call.
    if (
      !this.lastJunkTab &&
      this.ctx.knownTopLabels.size >= 2 &&
      ![...this.ctx.knownTopLabels].some((label) => isTTabLabel(label))
    ) {
      return points.length;
    }
    let targets = [...points];
    const tried = new Set<string>();
    const fileInto = async (label: string): Promise<void> => {
      tried.add(label);
      const before = targets.length;
      const left = await this.depositCells(targets, label);
      if (left < before) {
        await this.ctx.step(`junk: filed ${before - left} into ${label}`);
        this.lastJunkTab = label;
      }
      if (left === 0) {
        targets = [];
        return;
      }
      const still = new Set((await this.ctx.perception.currentBagCells()).map((cell) => `${cell.row},${cell.col}`));
      targets = targets.filter((cell) => still.has(`${cell.row},${cell.col}`));
    };
    if (this.lastJunkTab && targets.length > 0 && (await this.ctx.navigation.gotoTopTab(this.lastJunkTab))) {
      await fileInto(this.lastJunkTab);
    }
    // Strip candidates next — in a no-overflow layout the top list cannot
    // even open, but every T tab (if any) shows unclipped on the strip.
    let stripHadTTabs = false;
    if (targets.length > 0) {
      const strip = await this.ctx.kit.readStrip();
      this.ctx.navigation.noteTopStrip(strip.top);
      for (const entry of strip.top) {
        const label = entry.label.trim();
        if (!isTTabLabel(label) || isRemoveOnlyTabLabel(label)) continue;
        stripHadTTabs = true;
        if (targets.length === 0 || tried.has(label)) continue;
        if (!(await this.ctx.navigation.gotoTopTab(label))) {
          tried.add(label);
          continue;
        }
        await fileInto(label);
      }
    }
    // The dropdown only helps in overflow layouts (strip showed T tabs);
    // without that evidence its toggle does not exist and clicking is dead.
    for (let round = 0; round < 4 && stripHadTTabs && targets.length > 0; round += 1) {
      let rows: TabListRow[];
      try {
        rows = await this.ctx.navigation.openTopList(2);
      } catch {
        break;
      }
      const candidate = rows.find(
        (row) =>
          row.readable &&
          !tried.has(row.label) &&
          isTTabLabel(row.label) &&
          !isRemoveOnlyTabLabel(row.label),
      );
      if (!candidate) break;
      tried.add(candidate.label);
      if (
        !(await this.ctx.surfaceClick(
          LIST_ROW_CLICK_X,
          candidate.clickY,
          "tabList",
          `select junk tab ${candidate.label}`,
        ))
      ) {
        continue;
      }
      this.ctx.lastSelected = `top:${candidate.label}#0`;
      await this.ctx.park();
      await this.ctx.harness.sleep(300);
      await this.ctx.navigation.closeTopListFast();
      await fileInto(candidate.label);
    }
    return targets.length;
  }

  /**
   * Verified-serial withdraw for the shop flow (delists): ONE ctrl-click at
   * a time, the next only after the bag pixel-verifiably grew. Listings are
   * few and every one matters to the ledger — the serial commit check is the
   * point, not speed. Returns the items that actually left the tab.
   */
  async withdrawItemsSerial(
    items: readonly IdentifiedItem[],
    label: string,
  ): Promise<IdentifiedItem[]> {
    const withdrawn: IdentifiedItem[] = [];
    for (const item of items) {
      const before = await this.ctx.perception.bagCount();
      const sent = await this.ctx.harness.burst([item.cells[0]!], {
        found: items.flatMap((entry) => entry.cells),
        cellW: 56,
        cellH: 56,
        label: `shop withdraw ${withdrawn.length + 1}/${items.length} (${label})`,
      });
      if (sent === 0) return withdrawn; // rejected or dry-run
      let committed = false;
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline) {
        await this.ctx.harness.sleep(300, false);
        if ((await this.ctx.perception.bagCount()) > before) {
          committed = true;
          break;
        }
      }
      if (!committed) {
        this.ctx.harness.guard("shop-withdraw-not-observed", true);
        await this.ctx.step(`${label}: a shop withdraw did not commit — stopping the batch`);
        return withdrawn;
      }
      withdrawn.push(item);
      await this.ctx.harness.sleep(250, false);
    }
    return withdrawn;
  }

  /**
   * The EMPTY-BAG GUARANTEE (dump-sort handoff item 4): the run may not end
   * — other than Numpad 0 or fatal stash loss — while depositable identified
   * items remain in the bag. Keeps filing until the bag is verifiably empty
   * (TWO agreeing pixel reads; the bounce animation fakes empty frames) or
   * only blacklisted cells remain, then reports every leftover with its item
   * class and the reason it could not leave. Nothing is silently carried.
   */
  async finishBag(returnTo?: SourceTab): Promise<number> {
    const endPhase = this.ctx.harness.startPhase("finish-bag");
    let filed = 0;
    try {
      const deadDests = new Set<string>(this.ctx.fullDests);
      const navFailed = new Set<string>();
      for (let round = 0; round < 4; round += 1) {
        const occupied = await this.ctx.perception.currentBagCells();
        const verdict = bagCompletionVerdict(occupied, this.ctx.undepositableBag);
        if (verdict === "empty") {
          await this.ctx.harness.sleep(650, false);
          if ((await this.ctx.perception.currentBagCells()).length === 0) {
            endPhase();
            return filed;
          }
          continue; // a bounce flyback re-filled it — file again
        }
        if (verdict === "only-undepositable") break;
        filed += await this.ctx.distributeBag({ ...(returnTo ? { returnTo } : {}), deadDests, navFailed });
      }
      const leftovers = await this.ctx.perception.currentBagCells();
      if (leftovers.length === 0) {
        endPhase();
        return filed;
      }
      this.ctx.harness.guard("bag-not-empty-at-end", true);
      await this.ctx.step(`bag not empty at run end — identifying ${leftovers.length} leftover cell(s)`);
      const { items, unread } = await this.ctx.identification.identifyCells(leftovers, {});
      const report = describeBagLeftovers(items, unread, {
        undepositable: this.ctx.undepositableBag,
        stuckTabs: this.stuckObservations,
        unavailableDests: deadDests,
      });
      for (const entry of report) {
        this.ctx.log(
          `! bag leftover at ${entry.cell}: ${entry.itemClass ?? "unreadable"}` +
            (entry.dest && entry.dest !== "junk" ? ` (home ${entry.dest})` : "") +
            ` — ${entry.why}`,
        );
      }
      endPhase("leftovers-reported");
      return filed;
    } catch (error) {
      endPhase(error instanceof SortStop ? "stopped" : "failed");
      throw error;
    }
  }
}
