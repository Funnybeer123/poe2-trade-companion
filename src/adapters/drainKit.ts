import path from "node:path";
import { readFileSync, rmSync } from "node:fs";
import { bgrToGray, readBmpBgr } from "./bmp.js";
import type { WinReply } from "./winHost.js";
import { loadProfile } from "../core/calibrationStore.js";
import { occupiedFromRgbScores, scoreGridCellsRgb } from "../core/cellOccupancy.js";
import { occupiedFromScores, scoreGridCells } from "../core/itemSprites.js";
import { resolvePhysicalClient, type ScreenRect } from "../core/screenLayout.js";
import { snapRows, type ListRow, type OcrLine } from "../core/tabList.js";
import { stashContentSignature } from "../core/tabRouter.js";
import { perceiveUi, type UiFacts } from "../core/uiPerception.js";

export interface DrainHost {
  send(payload: Record<string, unknown>): Promise<WinReply>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const LIST_REGION = { left: 1340, top: 180, width: 760, height: 1430 };
const LIST_ROW_X = 1700;
const LIST_TOGGLE = { x: 1287, y: 212 };
const LIST_SCROLLBAR_X = 2005;
const PARK = { x: 660, y: 1900 };
const SWEEP_BOX = { x: 40, y: 262, w: 1250, h: 1240 };
const SWEEP_STEP = 56;

export interface KitSnapshot {
  facts: UiFacts;
  client: ScreenRect;
  rgbStash: Array<{ x: number; y: number }>;
  bagKeys: Set<string>;
  signature: number[];
}

export function normalizePattern(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Shared live-game primitives for stash draining: OCR-verified panel state,
 * scrollbar-driven tab-list access, perception snapshots with direct
 * calibrated-bag counting, and ctrl-click sweeps in both directions.
 */
export class DrainKit {
  private readonly artifactDir: string;
  readonly undepositable = new Set<string>();

  constructor(
    private readonly host: DrainHost,
    private readonly root: string,
    private readonly templateDir: string,
  ) {
    this.artifactDir = path.join(root, "artifacts", "assistive-cli");
  }

  async readWindow(): Promise<ListRow[]> {
    await this.host.send({ op: "move", x: PARK.x, y: PARK.y });
    await sleep(140);
    const reply = await this.host.send({ op: "ocr", ...LIST_REGION });
    if (!reply.ok) return [];
    return snapRows((Array.isArray(reply.lines) ? reply.lines : []) as OcrLine[]);
  }

  async scrollList(toTop: boolean): Promise<void> {
    await this.host.send({
      op: "drag",
      x: LIST_SCROLLBAR_X,
      y: 600,
      x2: LIST_SCROLLBAR_X,
      y2: toTop ? 185 : 1580,
    });
    await sleep(600);
  }

  async ensureListReadable(): Promise<ListRow[]> {
    let window = await this.readWindow();
    if (window.length < 5) {
      await this.host.send({ op: "click", x: LIST_TOGGLE.x, y: LIST_TOGGLE.y });
      await sleep(700);
      window = await this.readWindow();
    }
    return window;
  }

  async clickRow(row: ListRow): Promise<boolean> {
    const clicked = await this.host.send({ op: "click", x: LIST_ROW_X, y: row.clickY });
    if (!clicked.ok) return false;
    await sleep(650);
    return true;
  }

  /** Find and select the first row matching `pattern`; returns its label. */
  async gotoLabel(pattern: string, excludeRemoveOnly = false): Promise<string | undefined> {
    const wanted = normalizePattern(pattern);
    for (const toTop of [true, false]) {
      await this.scrollList(toTop);
      const window = await this.ensureListReadable();
      for (const row of window) {
        const normalized = normalizePattern(row.label);
        if (!normalized.includes(wanted)) continue;
        if (excludeRemoveOnly && /remove/.test(normalized)) continue;
        if (await this.clickRow(row)) return row.label;
      }
    }
    return undefined;
  }

  async panelsViaOcr(): Promise<{ stash: boolean; inventory: boolean }> {
    const stashBand = await this.host.send({ op: "ocr", left: 450, top: 100, width: 700, height: 110 });
    const invBand = await this.host.send({ op: "ocr", left: 2900, top: 100, width: 800, height: 110 });
    return {
      stash: /stash/i.test(String(stashBand.text ?? "")),
      inventory: /inventor/i.test(String(invBand.text ?? "")),
    };
  }

  async clickStashChest(): Promise<void> {
    const world = await this.host.send({ op: "ocr", left: 1200, top: 300, width: 1800, height: 1000 });
    const lines = (Array.isArray(world.lines) ? world.lines : []) as OcrLine[];
    const plate = lines.find((line) => /^stash$/i.test(line.text.trim()));
    const x = plate ? Math.round(plate.x + plate.w / 2) : 1790;
    const y = plate ? Math.round(plate.y + plate.h / 2 + 70) : 505;
    await this.host.send({ op: "focus" });
    await sleep(300);
    await this.host.send({ op: "click", x, y });
    await sleep(2600);
  }

  async ensurePanelsOpen(): Promise<void> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const panels = await this.panelsViaOcr();
      if (panels.stash && panels.inventory) return;
      if (!panels.stash) {
        await this.clickStashChest();
        continue;
      }
      await this.host.send({ op: "focus" });
      await sleep(250);
      await this.host.send({ op: "hotkey", keys: "i" });
      await sleep(700);
    }
    const panels = await this.panelsViaOcr();
    if (!panels.stash || !panels.inventory) throw new Error("panels-not-restorable");
  }

  async snapshot(): Promise<KitSnapshot> {
    const rect = await this.host.send({ op: "rect" });
    if (!rect.ok) throw new Error("target-window-missing");
    const file = path.join(this.artifactDir, `kit-${Date.now()}.bmp`);
    const captured = await this.host.send({ op: "capture", path: file });
    if (!captured.ok) throw new Error(String(captured.error ?? "capture-failed"));
    const bgr = readBmpBgr(file);
    rmSync(file, { force: true });
    const client = resolvePhysicalClient(
      { left: Number(captured.left), top: Number(captured.top), width: Number(captured.width), height: Number(captured.height) },
      Number(rect.monitorWidth) || Number(captured.width),
      Number(rect.monitorHeight) || Number(captured.height),
      { left: Number(rect.monitorLeft ?? 0), top: Number(rect.monitorTop ?? 0) },
    );
    const frame = bgrToGray(bgr);
    const profile = loadProfile(this.templateDir);
    const facts = perceiveUi(frame, client, {}, profile, bgr);
    let rgbStash: Array<{ x: number; y: number }> = [];
    if (facts.stashRegion && facts.stashGridSize) {
      rgbStash = occupiedFromRgbScores(
        scoreGridCellsRgb(bgr, client, facts.stashRegion, facts.stashGridSize.cols, facts.stashGridSize.rows),
      );
    }
    const bagKeys = new Set<string>();
    if (profile.bagGrid) {
      const bagBox = {
        x: client.left + profile.bagGrid.x,
        y: client.top + profile.bagGrid.y,
        w: profile.bagGrid.w,
        h: profile.bagGrid.h,
      };
      for (const cell of occupiedFromScores(scoreGridCells(frame, client, bagBox, 12, 5))) {
        bagKeys.add(`${cell.row},${cell.col}`);
      }
      for (const cell of occupiedFromRgbScores(scoreGridCellsRgb(bgr, client, bagBox, 12, 5))) {
        bagKeys.add(`${cell.row},${cell.col}`);
      }
    }
    for (const cell of facts.occupiedBag) bagKeys.add(`${cell.row},${cell.col}`);
    const signature = facts.stashRegion
      ? stashContentSignature(frame, client, facts.stashRegion)
      : [];
    return { facts, client, rgbStash, bagKeys, signature };
  }

  async verifiedBag(): Promise<{ count: number; keys: Set<string> }> {
    await this.ensurePanelsOpen();
    const snap = await this.snapshot();
    const keys = new Set(snap.bagKeys);
    for (const key of this.undepositable) keys.delete(key);
    return { count: keys.size, keys };
  }

  async burst(points: Array<{ x: number; y: number }>, shift = false): Promise<void> {
    for (let i = 0; i < points.length; i += 40) {
      const slice = points.slice(i, i + 40);
      let burst = await this.host.send({ op: "ctrlburst", points: slice, shift });
      if (!burst.ok && /focus/i.test(String(burst.error ?? ""))) {
        await this.host.send({ op: "focus" });
        await sleep(400);
        burst = await this.host.send({ op: "ctrlburst", points: slice, shift });
      }
      if (!burst.ok) throw new Error(`burst-failed:${burst.error}`);
      await sleep(110);
    }
  }

  /** Withdraw pass over the stash panel; returns the verified bag count after. */
  async sweepStash(targeted: boolean, latticePhase: number, shift = false): Promise<number> {
    const before = await this.snapshot();
    const candidates = new Map<string, { x: number; y: number }>();
    for (const cell of before.facts.occupiedStash) candidates.set(`${cell.x},${cell.y}`, { x: cell.x, y: cell.y });
    for (const cell of before.rgbStash) candidates.set(`${cell.x},${cell.y}`, { x: cell.x, y: cell.y });
    let points: Array<{ x: number; y: number }>;
    if (targeted && candidates.size > 0) {
      points = [...candidates.values()];
    } else {
      const offset = latticePhase % 2 === 0 ? 0 : Math.floor(SWEEP_STEP / 2);
      points = [];
      for (let y = SWEEP_BOX.y + offset; y < SWEEP_BOX.y + SWEEP_BOX.h; y += SWEEP_STEP) {
        for (let x = SWEEP_BOX.x + offset; x < SWEEP_BOX.x + SWEEP_BOX.w; x += SWEEP_STEP) {
          points.push({ x: before.client.left + x, y: before.client.top + y });
        }
      }
    }
    await this.host.send({ op: "focus" });
    await sleep(250);
    await this.burst(points, shift);
    await sleep(350);
    return (await this.verifiedBag()).count;
  }

  /** Deposit by ctrl-clicking every calibrated bag cell center. */
  async depositBag(shift = false): Promise<void> {
    const profile = loadProfile(this.templateDir);
    if (!profile.bagGrid) throw new Error("bag-grid-not-calibrated");
    const snap = await this.snapshot();
    const box = {
      x: snap.client.left + profile.bagGrid.x,
      y: snap.client.top + profile.bagGrid.y,
      w: profile.bagGrid.w,
      h: profile.bagGrid.h,
    };
    const points: Array<{ x: number; y: number }> = [];
    for (let row = 0; row < 5; row += 1) {
      for (let col = 0; col < 12; col += 1) {
        points.push({
          x: Math.round(box.x + (box.w * (col + 0.5)) / 12),
          y: Math.round(box.y + (box.h * (row + 0.5)) / 5),
        });
      }
    }
    await this.host.send({ op: "focus" });
    await sleep(250);
    await this.burst(points, shift);
    await sleep(400);
  }
}

export function loadCanonicalLabels(root: string): string[] {
  try {
    const parsed = JSON.parse(
      readFileSync(path.join(root, "artifacts", "tab-survey", "tab-inventory.json"), "utf8"),
    ) as { canonical: string[] };
    return parsed.canonical;
  } catch {
    return [];
  }
}
