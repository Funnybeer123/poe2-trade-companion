import type { WinReply } from "./winHost.js";
import { alignWindow, labelsSimilar, snapRows, type ListRow, type OcrLine } from "../core/tabList.js";
import { isProtectedTabLabel } from "../core/stashTabAdmin.js";

export interface TabNavHost {
  send(payload: Record<string, unknown>): Promise<WinReply>;
}

export interface TabNavigatorOptions {
  /** OCR region covering the tab-list dropdown (screen coords). */
  listRegion?: { left: number; top: number; width: number; height: number };
  rowClickX?: number;
  listCenter?: { x: number; y: number };
  listToggle?: { x: number; y: number };
  /** Neutral cursor park position that never hovers an item. */
  park?: { x: number; y: number };
}

const DEFAULTS: Required<TabNavigatorOptions> = {
  listRegion: { left: 1340, top: 180, width: 760, height: 1430 },
  rowClickX: 1700,
  listCenter: { x: 1700, y: 800 },
  listToggle: { x: 1287, y: 212 },
  park: { x: 660, y: 1900 },
};

/** The list scrolls only via its scrollbar; drag the thumb to either end. */
const SCROLLBAR_X = 2005;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Navigates stash tabs by canonical index through the tab-list dropdown:
 * anchor the list, OCR it, align the visible window against the canonical
 * label list, and click the requested row — auto-scrolling via bottom-row
 * selection when the target sits below the fold.
 */
export class TabNavigator {
  private readonly options: Required<TabNavigatorOptions>;

  constructor(
    private readonly host: TabNavHost,
    private canonical: string[],
    options: TabNavigatorOptions = {},
  ) {
    this.options = { ...DEFAULTS, ...options };
  }

  get labels(): string[] {
    return this.canonical;
  }

  private async readWindow(): Promise<ListRow[]> {
    await this.host.send({ op: "move", x: this.options.park.x, y: this.options.park.y });
    await sleep(130);
    const reply = await this.host.send({ op: "ocr", ...this.options.listRegion });
    if (!reply.ok) return [];
    return snapRows((Array.isArray(reply.lines) ? reply.lines : []) as OcrLine[]);
  }

  private async scrollList(toTop: boolean): Promise<void> {
    await this.host.send({
      op: "drag",
      x: SCROLLBAR_X,
      y: toTop ? 700 : 900,
      x2: SCROLLBAR_X,
      y2: toTop ? 185 : 1580,
    });
    await sleep(600);
  }

  /**
   * Select a tab by canonical index.
   *
   * The user reorders and folders tabs while the app is running, so the index
   * is only a hint: the row we are about to click is checked by label before
   * the click lands, and a protected tab is refused outright rather than
   * selected. Callers that know the label should prefer {@link gotoLabel}.
   */
  async goto(index: number): Promise<void> {
    const expected = this.canonical[index];
    if (expected !== undefined && isProtectedTabLabel(expected)) {
      throw new Error(`refusing-protected-tab:${expected}`);
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      for (const toTop of [index <= 25, index > 25]) {
        await this.scrollList(toTop);
        let window = await this.readWindow();
        if (window.length < 5) {
          await this.host.send({ op: "click", x: this.options.listToggle.x, y: this.options.listToggle.y });
          await sleep(700);
          window = await this.readWindow();
          if (window.length < 5) continue;
        }
        const shift = alignWindow(window, this.canonical);
        if (shift === undefined) continue;
        const row = window[index - shift];
        if (!row) continue;
        // The list may have been re-ordered since the canonical list was
        // captured; never click a row that now reads as protected.
        if (isProtectedTabLabel(row.label)) {
          throw new Error(`refusing-protected-tab:${row.label}`);
        }
        if (expected !== undefined && row.readable && !labelsSimilar(row.label, expected)) {
          // Index no longer addresses the tab we meant — re-align next attempt.
          continue;
        }
        const clicked = await this.host.send({ op: "click", x: this.options.rowClickX, y: row.clickY });
        if (!clicked.ok) continue;
        await sleep(650);
        return;
      }
    }
    throw new Error(`goto-tab-${index}-failed`);
  }

  /**
   * Select the first tab whose label matches, scanning the list from both ends.
   * Protected tabs — priced (`~price ...`) and Remove-only — are skipped, never
   * selected: their names are public listings and their contents are the
   * user's priced stock.
   */
  async gotoLabel(label: string): Promise<string> {
    if (isProtectedTabLabel(label)) throw new Error(`refusing-protected-tab:${label}`);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      for (const toTop of [true, false]) {
        await this.scrollList(toTop);
        let window = await this.readWindow();
        if (window.length < 5) {
          await this.host.send({ op: "click", x: this.options.listToggle.x, y: this.options.listToggle.y });
          await sleep(700);
          window = await this.readWindow();
        }
        for (const row of window) {
          if (!row.readable || isProtectedTabLabel(row.label)) continue;
          if (!labelsSimilar(row.label, label)) continue;
          const clicked = await this.host.send({ op: "click", x: this.options.rowClickX, y: row.clickY });
          if (!clicked.ok) continue;
          await sleep(650);
          return row.label;
        }
      }
    }
    throw new Error(`goto-tab-label-${label}-failed`);
  }
}
