/**
 * Live driver for the in-game Stash Tab Settings dialog: reads the tab strip,
 * opens a tab's settings by right-clicking its header, and rewrites the name
 * and colour.
 *
 * Every write re-reads the dialog's own Name field first, so a mis-aimed
 * right-click can never rename a priced or Remove-only tab.
 */
import type { WinReply } from "./winHost.js";
import { labelsEqualFolded, labelsSimilar, snapRows } from "../core/tabList.js";
import {
  COLOUR_GRID,
  colourByName,
  colourPoint,
  isRemoveOnlyTabLabel,
  looksPricedTabLabel,
  type StashTabColour,
} from "../core/stashTabAdmin.js";

export interface TabHost {
  send(payload: Record<string, unknown>): Promise<WinReply>;
}

export interface OcrLine {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Mouse parking spot: clear of every panel, so hover tooltips never occlude OCR. */
const PARK = { x: 660, y: 1900 };

/** The tab strip's two rows: top-level tabs, and the open folder's contents. */
export const STRIP_ROWS = {
  top: { min: 180, max: 245, scrollLeft: { x: 52, y: 212 }, scrollRight: { x: 1217, y: 210 } },
  folder: { min: 250, max: 320, scrollLeft: { x: 52, y: 277 }, scrollRight: { x: 1217, y: 275 } },
} as const;

export type StripRowName = keyof typeof STRIP_ROWS;

/**
 * The Stash Tab Settings dialog is positioned relative to the tab header you
 * right-click, so it MOVES between opens. Nothing inside it may be addressed
 * by a fixed screen coordinate — every control is measured as an offset from a
 * label the OCR can find in that particular dialog.
 *
 * Offsets below were taken from two dialogs at different screen positions and
 * agree to within a few pixels.
 */
const DIALOG = {
  titlePattern: /stash\s*tab\s*settings/i,
  namePattern: /^name$/i,
  colourPattern: /^colou?r$/i,
  footerPattern: /cannot share the same stash affinity/i,
  /** Only rendered while the tab is Public. */
  pricePattern: /set (exact|the) price|price on all items/i,
  /** Text input, from the top-left of the "Name" label. */
  nameFromLabel: { dx: 569, dy: 16 },
  /** Centre of the first colour swatch, from the top-left of "Colour". */
  paletteFromLabel: { dx: 226, dy: 27 },
  /** Confirm tick: x from the title's centre, y from the footer's top. */
  confirmFromTitleCentreX: 565,
  confirmFromFooterY: 73,
  /** Close cross, from the title's centre / top. */
  closeFromTitleCentreX: 594,
  closeFromTitleY: -6,
} as const;

/**
 * The vertical tab-list dropdown, which is the reliable way to address tabs.
 *
 * Unlike the horizontal strip it renders every label in full (no clipping to
 * "rice 5 exalted"), it does not scroll sideways under us, and row order is
 * stable across renames — so rows can be addressed by index.
 */
export const TAB_LIST = {
  // 760px wide is the proven crop from the drain tooling. Do NOT narrow it:
  // ~410px sizes fall into the Windows.Media.Ocr dead zone and intermittently
  // return almost no lines, which reads as "dropdown closed". World text that
  // leaks into the crop is filtered by position and shape instead.
  region: { left: 1340, top: 180, width: 760, height: 1430 },
  /**
   * Every real row label starts in a narrow column (x≈1379 for icon-prefixed
   * reads, x≈1426-1436 for clean ones). World nameplates land at arbitrary x
   * (ELINA 1341, ZOLIN 1552, DORYANI 1712), so the column is the strongest
   * filter for separating rows from world text.
   */
  labelColumn: { min: 1360, max: 1450 },
  // Row-click x must sit inside the NARROW folder-chevron dropdown too
  // (~330px wide, ending ≈1620): 1700 landed on the game world and closed
  // the panels. 1430 is the sorter's proven row-click x for both lists.
  rowX: 1430,
  toggle: { x: 1287, y: 212 },
} as const;

/**
 * Chat lines render behind the dropdown panel and land in the same OCR crop.
 * Matches the channel sigils PoE prefixes them with (`#global`, `@whisper`,
 * `$trade`, `%party`, `&guild`) and the "PlayerName: message" shape.
 */
const CHAT_LINE = /^\s*[#@$%&]|^\s*\w[\w ]*:\s/;

/**
 * World NPC nameplates (ZELINA, DORYANI, ALVA, ANGE …) OCR as one short
 * all-caps word. The 4-8 length keeps the AFFINITIES folder row (10 chars):
 * filtering that out once punched a two-blank hole into the snapped grid and
 * the trailing-trim rule truncated the whole list to a single row.
 */
const NPC_PLATE = /^[A-Z]{4,8}$/;

export interface TabListRow {
  index: number;
  label: string;
  readable: boolean;
  clickY: number;
}

export interface StripEntry {
  label: string;
  row: StripRowName;
  /** Centre of the tab header, for clicking or right-clicking. */
  point: { x: number; y: number };
  /** OCR line width, for clicking a specific part of a merged label. */
  width: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface DialogState {
  open: boolean;
  /** Name currently in the Name field, as read back from the dialog. */
  name?: string;
  /** True while the tab is Public — the price controls are on screen. */
  publiclyListed?: boolean;
  /** Where to click to focus the Name input, for this dialog's position. */
  nameField?: Point;
  /** Centre of palette swatch (0,0), for this dialog's position. */
  paletteOrigin?: Point;
  /** Confirm tick. Its presence also proves this is a tab, not a folder. */
  confirmPoint?: Point;
  closePoint?: Point;
}

/**
 * Resolve a label to exactly one visible tab.
 *
 * An exact match wins outright. Otherwise the loose matcher is used, but only
 * when it hits a single entry: priced labels differ by one digit
 * ("~price 1 exalted" vs "~price 5 exalted") and `labelsSimilar` happily
 * conflates them, which would rename the wrong tab. Ambiguity is a miss.
 */
/**
 * Exact-only resolution for WRITE operations (renames): the entry must
 * fold-equal the label, or — because adjacent headers OCR as one merged
 * line — start with it as a word-prefix. Loose containment once picked
 * QuarterStaff for "Staff" and renamed the wrong tab.
 */
export function pickExact(entries: readonly StripEntry[], label: string): StripEntry | undefined {
  const hits = entries.filter((entry) => {
    if (labelsEqualFolded(entry.label, label)) return true;
    let acc = "";
    for (const word of entry.label.trim().split(/\s+/)) {
      acc = acc ? `${acc} ${word}` : word;
      if (labelsEqualFolded(acc, label)) return true;
    }
    return false;
  });
  return hits.length === 1 ? hits[0] : undefined;
}

/**
 * Find `label` as a word-run SEGMENT inside a merged strip line ("2h Mace
 * Staff Sceptres" hides three headers in one OCR read) and synthesize an
 * entry positioned over that segment, proportional to character offsets.
 * The dialog's own Name check remains the hard gate after the right-click.
 */
export function findLabelSegment(
  entries: readonly StripEntry[],
  label: string,
): StripEntry | undefined {
  for (const entry of entries) {
    const trimmed = entry.label.trim();
    const words = trimmed.split(/\s+/);
    if (words.length < 2) continue;
    let offset = 0;
    for (let i = 0; i < words.length; i += 1) {
      let acc = "";
      for (let j = i; j < words.length; j += 1) {
        acc = acc ? `${acc} ${words[j]}` : words[j]!;
        if (labelsEqualFolded(acc, label)) {
          const startFrac = offset / trimmed.length;
          const endFrac = Math.min(1, (offset + acc.length) / trimmed.length);
          const left = entry.point.x - entry.width / 2;
          return {
            ...entry,
            label,
            point: {
              x: Math.round(left + ((startFrac + endFrac) / 2) * entry.width),
              y: entry.point.y,
            },
            width: Math.max(30, Math.round((endFrac - startFrac) * entry.width)),
          };
        }
      }
      offset += words[i]!.length + 1;
    }
  }
  return undefined;
}

export function pickUnique(entries: readonly StripEntry[], label: string): StripEntry | undefined {
  const exact = entries.filter((entry) => entry.label === label);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return undefined;
  const loose = entries.filter(
    (entry) => entry.label.length >= 3 && labelsSimilar(entry.label, label),
  );
  return loose.length === 1 ? loose[0] : undefined;
}

export class StashTabKit {
  constructor(private readonly host: TabHost) {}

  private async park(): Promise<void> {
    await this.host.send({ op: "move", ...PARK });
  }

  /**
   * Send a pointer op with a visible marker first: a red box + label held at
   * the exact point BEFORE the button goes down, so the user can watch where
   * automation is about to act (asked for after a mis-aimed dropdown click
   * closed the stash). Set POE2_SHOW_CLICKS=0 to disable the markers.
   */
  private async pointer(
    op: "click" | "rightclick",
    x: number,
    y: number,
    why: string,
  ): Promise<void> {
    const show = process.env.POE2_SHOW_CLICKS !== "0";
    if (show) {
      await this.host
        .send({
          op: "marks",
          rects: [
            { x: Math.round(x) - 22, y: Math.round(y) - 22, w: 44, h: 44, kind: "click", label: why },
          ],
        })
        .catch(() => undefined);
      await sleep(500);
    }
    await this.host.send({ op, x: Math.round(x), y: Math.round(y) });
    if (show) await this.host.send({ op: "hidemark" }).catch(() => undefined);
  }

  /**
   * OCR until two consecutive reads agree. The game animates panel and dialog
   * transitions, and a single read taken mid-animation returns a half-drawn
   * frame that misses rows entirely.
   */
  async settledOcr(maxTries = 6): Promise<OcrLine[]> {
    let previous = "";
    let lines: OcrLine[] = [];
    for (let attempt = 0; attempt < maxTries; attempt += 1) {
      await sleep(320);
      const reply = await this.host.send({ op: "ocr" });
      lines = (Array.isArray(reply.lines) ? reply.lines : []) as OcrLine[];
      const key = lines.map((line) => `${line.x},${line.y}:${line.text}`).join("|");
      if (key === previous) return lines;
      previous = key;
    }
    return lines;
  }

  /** Tab headers visible in one strip row, left to right. */
  stripEntries(lines: readonly OcrLine[], row: StripRowName): StripEntry[] {
    const band = STRIP_ROWS[row];
    return lines
      .filter((line) => line.x < 1340 && line.y >= band.min && line.y <= band.max)
      .sort((a, b) => a.x - b.x)
      .map((line) => ({
        label: line.text.trim(),
        row,
        point: { x: Math.round(line.x + line.w / 2), y: Math.round(line.y + line.h / 2) },
        width: line.w,
      }));
  }

  async readStrip(): Promise<{ top: StripEntry[]; folder: StripEntry[] }> {
    await this.park();
    const lines = await this.settledOcr();
    return { top: this.stripEntries(lines, "top"), folder: this.stripEntries(lines, "folder") };
  }

  /** Read the tab-list dropdown, snapping OCR lines onto its row pitch. */
  async readTabList(): Promise<TabListRow[]> {
    await this.park();
    await sleep(150);
    // Full-screen OCR, filtered client-side. Region crops at this size hit the
    // Windows.Media.Ocr dead zone and intermittently return ZERO lines even
    // with the dropdown visibly open — the full 3840x2160 grab never does.
    const reply = await this.host.send({ op: "ocr" });
    if (!reply.ok) return [];
    const all = (Array.isArray(reply.lines) ? reply.lines : []) as OcrLine[];
    const lines = all.filter(
      (line) =>
        line.y >= TAB_LIST.region.top &&
        line.y <= TAB_LIST.region.top + TAB_LIST.region.height &&
        line.x >= TAB_LIST.region.left,
    );
    // Keep only plausible dropdown labels: starting in the label column, not
    // chat ("#user: msg" anchors the row grid far below the list), and not a
    // world NPC nameplate showing through the panel.
    const plausible = lines.filter(
      (line) =>
        line.x >= TAB_LIST.labelColumn.min &&
        line.x <= TAB_LIST.labelColumn.max &&
        !CHAT_LINE.test(line.text) &&
        !NPC_PLATE.test(line.text.trim()),
    );
    const rows = snapRows(plausible).map((row, index) => ({
      index,
      label: row.label,
      readable: row.readable,
      clickY: row.clickY,
    }));
    // Trim only TRAILING unreadable rows. Interior blanks are real tabs whose
    // labels OCR cannot see — "T1"/"T2"/"T3" are too short for the engine and
    // three renamed tabs in a row once produced a blank run that an overeager
    // "two blanks ends the list" rule mistook for the end, truncating 15 rows
    // down to 2. Phantom rows below the list are already prevented by the
    // label-column, chat, and nameplate filters above.
    let last = rows.length - 1;
    while (last >= 0 && !rows[last]!.readable) last -= 1;
    return rows.slice(0, last + 1);
  }

  /** OCR the stash title band; false means the panel is not on screen. */
  async stashPanelOpen(): Promise<boolean> {
    const band = await this.host.send({ op: "ocr", left: 450, top: 100, width: 700, height: 110 });
    if (/stash/i.test(String(band.text ?? ""))) return true;
    const lines = (Array.isArray(band.lines) ? band.lines : []) as OcrLine[];
    return lines.some((line) => /stash/i.test(line.text));
  }

  /**
   * Open the dropdown and return its rows, or throw.
   *
   * When the dropdown is closed — confirming a settings dialog closes it —
   * the OCR crop reads whatever the world renders there (NPC nameplates like
   * "DORYANI"), and clicking such a phantom "row" clicks into the world,
   * which can close the stash entirely. A list that never reaches `minRows`
   * is therefore an error, never a result to act on.
   */
  async ensureTabListOpen(minRows = 6, attempts = 3): Promise<TabListRow[]> {
    if (!(await this.stashPanelOpen())) throw new Error("stash-panel-closed");
    let rows: TabListRow[] = [];
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      // Two reads before touching anything: the `focus` op does SW_RESTORE on
      // a fullscreen game, which can blank a frame — and one blank read must
      // not make us toggle an OPEN dropdown closed and start oscillating.
      rows = await this.readTabList();
      if (rows.length >= minRows) return rows;
      await sleep(700);
      rows = await this.readTabList();
      if (rows.length >= minRows) return rows;
      // Genuinely closed (or unreadable) — toggle it.
      await this.host.send({ op: "focus" });
      await sleep(300);
      await this.pointer("click", TAB_LIST.toggle.x, TAB_LIST.toggle.y, "toggle tab list");
      await this.park();
      await sleep(900);
    }
    rows = await this.readTabList();
    if (rows.length < minRows) throw new Error(`tab-list-unreadable:${rows.length}-rows`);
    return rows;
  }

  /**
   * Select a tab from the dropdown. Right-clicking a dropdown row does NOT
   * open its settings — the list only selects — but selecting scrolls the
   * strip so that tab's header is on screen, which is what makes the header
   * findable afterwards.
   */
  async selectTabListRow(row: TabListRow): Promise<void> {
    await this.pointer("click", TAB_LIST.rowX, row.clickY, `select list row "${row.label}"`);
    await this.park();
    // Selecting scrolls the strip to bring the tab into view. Reading it while
    // that animation is still running yields a correct label at a position the
    // tab has already left, so the follow-up right-click lands on its
    // neighbour. Wait for the scroll to finish before anyone reads the strip.
    await sleep(1000);
  }

  /**
   * Select a tab via the dropdown, then open its settings from the strip.
   *
   * The dropdown supplies the tab's full, unclipped name; the dialog's own
   * Name field is then checked against it, so picking the wrong header from a
   * clipped strip label is detected rather than acted on.
   */
  async openSettingsViaList(
    row: TabListRow,
    attempts = 2,
  ): Promise<{ state: DialogState; entry?: StripEntry; mismatch?: string }> {
    let last: { state: DialogState; entry?: StripEntry; mismatch?: string } = {
      state: { open: false },
      mismatch: "header-not-found",
    };
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      await this.selectTabListRow(row);
      const strip = await this.readStrip();
      const entry =
        pickUnique(strip.top, row.label) ??
        pickUnique(strip.folder, row.label) ??
        findLabelSegment(strip.top, row.label) ??
        findLabelSegment(strip.folder, row.label);
      if (!entry) {
        last = { state: { open: false }, mismatch: "header-not-found" };
        continue;
      }
      const state = await this.openSettings(entry);
      // The dialog's own Name is the truth. A mismatch means the strip moved
      // under us between reading and clicking, so retry rather than proceed.
      // Folded EQUALITY, not similarity: "QuarterStaff" is similar to "Staff"
      // and similarity once let the wrong tab get renamed.
      if (state.open && state.name && !labelsEqualFolded(state.name, row.label)) {
        last = { state, entry, mismatch: `opened-${state.name}-wanted-${row.label}` };
        await this.closeSettings(state);
        continue;
      }
      return { state, entry };
    }
    return last;
  }

  /** Step a strip row one page left, so repeated calls can enumerate it. */
  async scrollStrip(row: StripRowName, direction: "left" | "right"): Promise<void> {
    const band = STRIP_ROWS[row];
    const target = direction === "left" ? band.scrollLeft : band.scrollRight;
    await this.pointer("click", target.x, target.y, `scroll strip ${direction}`);
    await this.park();
    await sleep(260);
  }

  /**
   * Walk a strip row from its left edge, collecting every distinct label.
   * Scrolling is pixel-based, so we stop once a step reveals nothing new.
   */
  async enumerateRow(row: StripRowName, maxSteps = 16): Promise<string[]> {
    for (let i = 0; i < maxSteps; i += 1) await this.scrollStrip(row, "left");
    const seen: string[] = [];
    for (let step = 0; step <= maxSteps; step += 1) {
      const strip = await this.readStrip();
      const labels = strip[row].map((entry) => entry.label);
      const added = labels.filter((label) => label && !seen.includes(label));
      seen.push(...added);
      if (step > 0 && added.length === 0) break;
      await this.scrollStrip(row, "right");
    }
    return seen;
  }

  /**
   * Scroll a strip row until `label` is on screen and return its live entry.
   * Strip positions shift as the row scrolls, so callers must re-locate a tab
   * immediately before clicking it rather than reusing an earlier entry.
   */
  async locate(
    label: string,
    rows: readonly StripRowName[] = ["folder", "top"],
    maxSteps = 16,
    exact = false,
  ): Promise<StripEntry | undefined> {
    const pick = exact ? pickExact : pickUnique;
    for (const row of rows) {
      const visible = pick((await this.readStrip())[row], label);
      if (visible) return visible;
      for (let i = 0; i < maxSteps; i += 1) await this.scrollStrip(row, "left");
      for (let step = 0; step <= maxSteps; step += 1) {
        const found = pick((await this.readStrip())[row], label);
        if (found) return found;
        await this.scrollStrip(row, "right");
      }
    }
    return undefined;
  }

  /**
   * Open a folder from the top row so its contents populate the folder row.
   *
   * Callers must not assume the game is already showing the right folder — any
   * earlier tab navigation (or an interrupted run) leaves the strip scrolled
   * somewhere else with the folder row closed.
   */
  async openFolder(name: string, maxSteps = 16): Promise<boolean> {
    const already = await this.readStrip();
    if (already.folder.length > 0) {
      const open = already.top.find((entry) => labelsSimilar(entry.label, name));
      // The second row can belong to the SPECIAL group (Currency, Flask,
      // Distilled …) while the wanted folder's header is still visible in the
      // top row — a populated row is not proof the RIGHT folder is open.
      const rowLooksForeign = already.folder.some((entry) =>
        /flask|abyss|breach|relic|map|fragment|ritual|rune|expedition|gem|delir|essenc|dist|price|\bcur\b|remove/i.test(
          entry.label,
        ),
      );
      if (open && !rowLooksForeign) return true;
    }
    const entry = await this.locate(name, ["top"], maxSteps);
    if (!entry) return false;
    await this.pointer("click", entry.point.x, entry.point.y, `open folder "${name}"`);
    await this.park();
    await sleep(700);
    return (await this.readStrip()).folder.length > 0;
  }

  /**
   * Walk a strip row left to right, opening each tab's settings once and
   * handing its **true** name (as the dialog renders it) to `visit`.
   *
   * This is the reliable way to address tabs whose strip labels are clipped or
   * near-identical: `~price 1 exalted` and `~price 5 exalted` are impossible to
   * tell apart from a scrolled strip, but their dialogs are unambiguous. Each
   * distinct dialog name is visited at most once.
   */
  async walkTabs(
    row: StripRowName,
    visit: (name: string, entry: StripEntry, state: DialogState) => Promise<"applied" | "skip">,
    options: {
      maxSteps?: number;
      /** Decide from the strip label alone whether to right-click at all. */
      shouldOpen?: (entry: StripEntry) => boolean;
      /**
       * Names already handled. The callback may push into this — a rename
       * changes the tab's name, and without recording the new one the walk
       * would meet the tab again and renumber it.
       */
      visited?: string[];
    } = {},
  ): Promise<string[]> {
    const maxSteps = options.maxSteps ?? 16;
    const visited = options.visited ?? [];
    // Strip labels already resolved to a tab we have handled. Right-clicking a
    // header also SELECTS that tab, which scrolls the strip, so a list of
    // entries captured before a dialog is stale the moment it closes — the
    // strip is re-read after every single dialog instead.
    const done = new Set<string>();
    for (let i = 0; i < maxSteps; i += 1) await this.scrollStrip(row, "left");

    let barren = 0;
    while (barren <= maxSteps) {
      const strip = await this.readStrip();
      const candidate = strip[row].find(
        (entry) =>
          entry.label &&
          !done.has(entry.label) &&
          (!options.shouldOpen || options.shouldOpen(entry)),
      );
      if (!candidate) {
        barren += 1;
        await this.scrollStrip(row, "right");
        continue;
      }
      barren = 0;
      done.add(candidate.label);

      const state = await this.openSettings(candidate);
      // A folder (or anything that is not a tab) has no affinity footer, so
      // there is no confirm tick — never treat it as a renameable tab.
      if (!state.open || !state.confirmPoint) {
        if (state.open) await this.closeSettings(state);
        continue;
      }
      const name = state.name ?? candidate.label;
      if (visited.includes(name)) {
        await this.closeSettings(state);
        continue;
      }
      visited.push(name);
      const outcome = await visit(name, candidate, state);
      if (outcome === "skip") await this.closeSettings(state);
      // Whatever the tab is called now, do not re-open it from the strip.
      done.add(name);
      for (const recorded of visited) done.add(recorded);
    }
    return visited;
  }

  /** Read the settings dialog's current state without changing anything. */
  async readDialog(): Promise<DialogState> {
    await this.park();
    const lines = await this.settledOcr();
    const title = lines.find((line) => DIALOG.titlePattern.test(line.text));
    if (!title) return { open: false };
    // The Name field's value renders to the right of the "NAME" label.
    const nameLabel = lines.find((line) => /^name$/i.test(line.text.trim()));
    const value = nameLabel
      ? lines
          .filter(
            (line) =>
              line.x > nameLabel.x + nameLabel.w &&
              Math.abs(line.y - nameLabel.y) < 40 &&
              line.x < 1200,
          )
          .sort((a, b) => a.x - b.x)[0]
      : undefined;
    const footer = lines.find((line) => DIALOG.footerPattern.test(line.text));
    const colourLabel = lines.find((line) => DIALOG.colourPattern.test(line.text.trim()));
    // The price controls only render for a tab that is currently Public, so
    // their presence is the authoritative "this tab is publicly listed" signal
    // — far more reliable than guessing from a clipped `~price ...` name.
    const publiclyListed = lines.some((line) => DIALOG.pricePattern.test(line.text));
    const titleCentreX = title.x + title.w / 2;
    return {
      open: true,
      name: value?.text.trim(),
      publiclyListed,
      ...(nameLabel
        ? {
            nameField: {
              x: Math.round(nameLabel.x + DIALOG.nameFromLabel.dx),
              y: Math.round(nameLabel.y + DIALOG.nameFromLabel.dy),
            },
          }
        : {}),
      ...(colourLabel
        ? {
            paletteOrigin: {
              x: Math.round(colourLabel.x + DIALOG.paletteFromLabel.dx),
              y: Math.round(colourLabel.y + DIALOG.paletteFromLabel.dy),
            },
          }
        : {}),
      ...(footer
        ? {
            confirmPoint: {
              x: Math.round(titleCentreX + DIALOG.confirmFromTitleCentreX),
              y: Math.round(footer.y + DIALOG.confirmFromFooterY),
            },
          }
        : {}),
      closePoint: {
        x: Math.round(titleCentreX + DIALOG.closeFromTitleCentreX),
        y: Math.round(title.y + DIALOG.closeFromTitleY),
      },
    };
  }

  /** Right-click a tab header and wait for its settings dialog. */
  async openSettings(entry: StripEntry): Promise<DialogState> {
    await this.host.send({ op: "focus" });
    await sleep(200);
    await this.pointer("rightclick", entry.point.x, entry.point.y, `settings of "${entry.label}"`);
    await this.park();
    return this.readDialog();
  }

  /**
   * Dismiss the dialog without saving. Needs the state that opened it, because
   * the close cross moves with the dialog; without it we would click a fixed
   * point that may now be over the stash grid and pick an item up.
   */
  async closeSettings(state?: DialogState): Promise<void> {
    const point = state?.closePoint ?? (await this.readDialog()).closePoint;
    if (!point) return;
    await this.pointer("click", point.x, point.y, "close dialog");
    await this.park();
    await sleep(400);
  }

  /** Click the confirm tick. Nothing is saved until this lands. */
  async confirmSettings(state: DialogState): Promise<void> {
    if (!state.confirmPoint) throw new Error("confirm-button-not-located");
    await this.pointer("click", state.confirmPoint.x, state.confirmPoint.y, "confirm dialog");
    await this.park();
    await sleep(500);
  }

  /** Replace the Name field contents, using this dialog's own field position. */
  async setName(newName: string, state: DialogState): Promise<void> {
    if (!state.nameField) throw new Error("name-field-not-located");
    await this.pointer("click", state.nameField.x, state.nameField.y, "name field");
    await sleep(220);
    await this.host.send({ op: "hotkey", keys: "ctrla" });
    await sleep(140);
    await this.host.send({ op: "hotkey", keys: "backspace" });
    await sleep(140);
    await this.host.send({ op: "type", text: newName });
    await sleep(260);
  }

  /** Click a palette swatch, relative to this dialog's own palette origin. */
  async setColour(colour: StashTabColour, state: DialogState): Promise<void> {
    if (!state.paletteOrigin) throw new Error("palette-not-located");
    const offset = colourPoint(colour);
    await this.pointer(
      "click",
      state.paletteOrigin.x + (offset.x - COLOUR_GRID.originX),
      state.paletteOrigin.y + (offset.y - COLOUR_GRID.originY),
      "colour swatch",
    );
    await sleep(260);
  }

  /**
   * Rename and recolour one tab, refusing outright if the dialog that actually
   * opened belongs to a priced or Remove-only tab. Returns the name read back
   * after the write, so callers can verify rather than assume.
   */
  async applyTabIdentity(
    entry: StripEntry,
    newName: string,
    colourName: string,
    options: { dryRun?: boolean; allowPricedTabs?: boolean; expectedLabel?: string } = {},
  ): Promise<{ applied: boolean; before?: string; after?: string; reason?: string }> {
    const colour = colourByName(colourName);
    if (!colour) return { applied: false, reason: `unknown-colour:${colourName}` };

    const opened = await this.openSettings(entry);
    if (!opened.open) return { applied: false, reason: "settings-dialog-did-not-open" };

    const before = opened.name ?? entry.label;
    // The dialog renders the tab's full, unclipped name. If that is not the tab
    // the plan named, we right-clicked the wrong header — abort rather than
    // rename it. Near-identical priced labels make this a live hazard.
    if (options.expectedLabel && !labelsSimilar(before, options.expectedLabel)) {
      await this.closeSettings(opened);
      return { applied: false, before, reason: `target-mismatch:wanted-${options.expectedLabel}` };
    }
    // Guard on what the dialog itself reports, not on the label we aimed at.
    if (!options.allowPricedTabs && looksPricedTabLabel(before)) {
      await this.closeSettings(opened);
      return { applied: false, before, reason: "refused-priced-tab" };
    }
    if (isRemoveOnlyTabLabel(before)) {
      await this.closeSettings(opened);
      return { applied: false, before, reason: "refused-remove-only-tab" };
    }
    if (options.dryRun) {
      await this.closeSettings(opened);
      return { applied: false, before, reason: "dry-run" };
    }

    await this.setName(newName, opened);
    await this.setColour(colour, opened);
    // Re-read: the dialog can shift as fields change, and the tick must be
    // clicked at its current position or nothing is saved.
    const reread = await this.readDialog();
    await this.confirmSettings(reread.confirmPoint ? reread : opened);

    const verify = await this.readStrip();
    const after = [...verify.top, ...verify.folder].find((tab) => tab.label === newName)?.label;
    return { applied: after === newName, before, after };
  }
}
