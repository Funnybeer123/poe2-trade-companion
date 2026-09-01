/**
 * Shared live-bag primitives for the map/hideout flows: one-capture client
 * resolve + sprite segmentation (with the RGB red-tint net), batched
 * hover+Ctrl+C reads, calibrated grid click helpers, OCR panel truth, and
 * the value-tier config loader. Extracted for scripts/vendor-cycle.ts;
 * scripts/map-triage.ts still carries its own copies (unify later).
 */

import path from "node:path";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { bgrToGray, readBmpBgr } from "./bmp.js";
import type { WinReply } from "./winHost.js";
import { occupiedFromRgbScores, scoreGridCellsRgb } from "../core/cellOccupancy.js";
import { detectSpriteItems } from "../core/itemSprites.js";
import { cellCenterTwoCorner } from "../core/gridMath.js";
import type { GridMark } from "../core/calibrationProfile.js";
import { resolvePhysicalClient, type ScreenRect } from "../core/screenLayout.js";
import type { OcrLine } from "../core/tabList.js";
import type { TriageSprite } from "../core/mapTriage.js";
import { starterPriceTable, validatePriceTable, type PriceTable } from "../core/priceTable.js";
import {
  DEFAULT_TIER_THRESHOLDS,
  starterValueTierRules,
  type ValueTierRules,
  type ValueTierThresholds,
} from "../core/valueTiers.js";

export interface KitHost {
  send(payload: Record<string, unknown>): Promise<WinReply>;
}

/** One capture resolves the DPI-scaled client AND segments the bag. */
export async function captureBagSprites(
  host: KitHost,
  scratchDir: string,
  bag: GridMark,
  cols: number,
  rows: number,
): Promise<{ client: ScreenRect; sprites: TriageSprite[] }> {
  const rect = await host.send({ op: "rect" });
  if (!rect.ok) throw new Error("poe-window-not-found — is Path of Exile 2 running?");
  const probeFile = path.join(scratchDir, `sprites-${Date.now()}.bmp`);
  const captured = await host.send({ op: "capture", path: probeFile });
  if (!captured.ok) throw new Error(String(captured.error ?? "capture-failed"));
  const bgr = readBmpBgr(probeFile);
  rmSync(probeFile, { force: true });
  const client = resolvePhysicalClient(
    {
      left: Number(captured.left),
      top: Number(captured.top),
      width: Number(captured.width),
      height: Number(captured.height),
    },
    Number(rect.monitorWidth) || Number(captured.width),
    Number(rect.monitorHeight) || Number(captured.height),
    { left: Number(rect.monitorLeft ?? 0), top: Number(rect.monitorTop ?? 0) },
  );
  const frame = bgrToGray(bgr);
  const region = { x: client.left + bag.x, y: client.top + bag.y, w: bag.w, h: bag.h };
  const grid = {
    topLeft: { x: region.x, y: region.y },
    bottomRight: { x: region.x + region.w, y: region.y + region.h },
  };
  const sprites = detectSpriteItems(frame, client, region, cols, rows).map((item) => {
    const center = cellCenterTwoCorner(
      grid,
      item.grab.col + (item.w - 1) / 2,
      item.grab.row + (item.h - 1) / 2,
      cols,
      rows,
    );
    return {
      id: item.id,
      row: item.grab.row,
      col: item.grab.col,
      w: item.w,
      h: item.h,
      x: item.grab.x,
      y: item.grab.y,
      cx: center.x,
      cy: center.y,
    };
  });
  // RGB net: gray sprite detection misses items on the game's red cell tint.
  const covered = new Set<string>();
  for (const sprite of sprites) {
    for (let r = 0; r < sprite.h; r += 1) {
      for (let c = 0; c < sprite.w; c += 1) covered.add(`${sprite.row + r},${sprite.col + c}`);
    }
  }
  for (const cell of occupiedFromRgbScores(scoreGridCellsRgb(bgr, client, region, cols, rows))) {
    if (covered.has(`${cell.row},${cell.col}`)) continue;
    covered.add(`${cell.row},${cell.col}`);
    sprites.push({
      id: `rgb-${cell.row},${cell.col}`,
      row: cell.row,
      col: cell.col,
      w: 1,
      h: 1,
      x: cell.x,
      y: cell.y,
      cx: cell.x,
      cy: cell.y,
    });
  }
  return { client, sprites };
}

/** Batched hover+Ctrl+C over many points — one host round trip. */
export async function copyPoints(
  host: KitHost,
  points: Array<{ x: number; y: number }>,
  label: string,
): Promise<string[]> {
  if (points.length === 0) return [];
  const sentinel = `poe2-bagkit-${Date.now()}-${label}`;
  const reply = await host.send({ op: "copysweep", points, hoverMs: 100, sentinel });
  const texts = Array.isArray(reply.texts) ? (reply.texts as string[]) : [];
  return points.map((_, index) => String(texts[index] ?? ""));
}

/** Panel truth = the OCR'd title banners, never grid heuristics. */
export async function panelsViaOcr(host: KitHost): Promise<{ stash: boolean; inventory: boolean }> {
  const stashBand = await host.send({ op: "ocr", left: 450, top: 100, width: 700, height: 110 });
  const invBand = await host.send({ op: "ocr", left: 2900, top: 100, width: 800, height: 110 });
  return {
    stash: /stash/i.test(String(stashBand.text ?? "")),
    inventory: /inventor/i.test(String(invBand.text ?? "")),
  };
}

/**
 * Full-screen OCR line hunt (mid-size crops hit a Windows.Media.Ocr dead
 * zone, so nameplates must be found on whole-screen grabs). Returns the
 * line's centre; `clickOffsetY` shifts the click below the label (world
 * nameplates float above their object).
 */
export async function findOcrLines(host: KitHost, holdAlt = false): Promise<OcrLine[]> {
  const reply = await host.send(holdAlt ? { op: "ocr", holdAlt: true } : { op: "ocr" });
  return (Array.isArray(reply.lines) ? reply.lines : []) as OcrLine[];
}

export function lineCenter(line: OcrLine, clickOffsetY = 0): { x: number; y: number } {
  return { x: Math.round(line.x + line.w / 2), y: Math.round(line.y + line.h / 2 + clickOffsetY) };
}

export interface TriageConfig {
  rules: ValueTierRules;
  thresholds: ValueTierThresholds;
  priceTable: PriceTable;
  routing: { reviewTab: string; dumpTab: string; sellTab?: string };
  source: string;
}

/** The same value-tier export the sorter and map-triage use. */
export function loadTriageConfig(root: string): TriageConfig {
  let rules = starterValueTierRules();
  let thresholds: ValueTierThresholds = { ...DEFAULT_TIER_THRESHOLDS };
  let priceTable = starterPriceTable();
  let routing: TriageConfig["routing"] = { reviewTab: "Review", dumpTab: "Dump" };
  let source = "starter tiers (no artifacts/tab-admin/triage.json export)";
  const file = path.join(root, "artifacts", "tab-admin", "triage.json");
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as {
        rules?: ValueTierRules;
        thresholds?: ValueTierThresholds;
        priceTable?: unknown;
        routing?: TriageConfig["routing"];
      };
      if (parsed.rules?.keep && parsed.rules.sell && parsed.rules.dump) rules = parsed.rules;
      if (parsed.thresholds) thresholds = { ...thresholds, ...parsed.thresholds };
      const tableCheck = validatePriceTable(parsed.priceTable);
      if (tableCheck.valid && tableCheck.table) priceTable = tableCheck.table;
      if (parsed.routing?.reviewTab && parsed.routing.dumpTab) routing = parsed.routing;
      source = "artifacts/tab-admin/triage.json";
    } catch {
      // starter tiers on an unreadable export
    }
  }
  return { rules, thresholds, priceTable, routing, source };
}
